"""TFLite NN training orchestration.

First training run (>= ANALYTICS_TRAIN_MIN_ROWS labeled windows) builds a fresh
Keras model + converts to TFLite. Subsequent runs OPEN the saved model and
FINE-TUNE it on the cumulative labeled window history; storage is never wiped.

Each run performs RANDOM-SEARCH hyperparameter tuning over trials and records
precision/recall/accuracy/F1 + confusion matrix per trial. Every trial is
logged to training_runs and streamed live via training.* events; the best
model (by macro-F1, falling back to accuracy) is selected and exported as
SavedModel + TFLite.
"""

from __future__ import annotations

import random
import threading
import time

import numpy as np

from . import mathlib
from .config import Config, model_savedmodel_path, model_tflite_path
from .events import EventBus
from .warehouse import RedisStore, SqliteStore, now_ms

LABELS = {"normal": 0, "watch": 1, "high": 2}
LABEL_NAMES = ["normal", "watch", "high"]

_KEYS = {"rows": 0, "threshold": 0, "epochs": 0, "state": "idle", "startedAt": None,
         "finishedAt": None, "error": None, "run": 0, "trials": 0,
         "best": None, "lastTrial": None, "trainedUpTo": None}


class TrainingOrchestrator:
    def __init__(self, cfg: Config, store: SqliteStore, redis: RedisStore,
                 events: EventBus | None = None, runtime: RuntimeConfig | None = None):
        self.cfg = cfg
        self.store = store
        self.redis = redis
        self.events = events or EventBus()
        self.runtime = runtime or RuntimeConfig(cfg, store)
        self._lock = threading.Lock()
        self.state = self._load_state()

    def _load_state(self) -> dict:
        st = self.redis.get_training_state()
        if st:
            return st
        base = dict(_KEYS)
        last = self.store.last_training_run()
        if last:
            base.update({"state": last["state"], "startedAt": last["startedAt"],
                         "finishedAt": last["finishedAt"], "error": last["error"],
                         "modelFile": last["modelFile"], "rows": last["rows"] or 0,
                         "threshold": self.cfg.train_min_rows,
                         "epochs": last["epochs"] or self.cfg.train_epochs,
                         "best": last.get("hp") and {"config": last["hp"],
                                                     "metrics": last["metrics"],
                                                     "confusion": last["confusion"]} or None})
        return base

    def _persist(self) -> None:
        self.redis.set_training_state(dict(self.state))

    def _emit(self, type_: str, **extra) -> None:
        payload = dict(extra)
        payload["type"] = type_
        payload["timestamp"] = now_ms()
        self.events.emit(payload)

    def status(self) -> dict:
        rows = self.store.count_windows()
        sm = model_savedmodel_path(self.cfg)
        tm = model_tflite_path(self.cfg)
        active = self.store.get_active_risk_model()
        return {
            "state": self.state.get("state", "idle"),
            "rows": rows,
            "minRows": self.runtime.train_min_rows,
            "epochs": self.runtime.train_epochs,
            "trials": self.runtime.train_trials,
            "kinds": self.runtime.train_kinds,
            "startedAt": self.state.get("startedAt"),
            "finishedAt": self.state.get("finishedAt"),
            "error": self.state.get("error"),
            "run": self.state.get("run", 0),
            "best": self.state.get("best"),
            "savedModel": str(sm) if sm.exists() else None,
            "tfliteModel": str(tm) if tm.exists() else None,
            "modelBytes": sm.stat().st_size if sm.exists() else None,
            "tfliteBytes": tm.stat().st_size if tm.exists() else None,
            "modelActive": tm.exists(),
            "modelMetadata": active.get("metadata") if active else None,
            "trainedUpTo": self.runtime.watermark
            if self.state.get("trainedUpTo") is None else self.state.get("trainedUpTo"),
            "cron": self.runtime.cron,
        }

    def should_train(self) -> bool:
        st = self.status()
        if st["state"] == "running":
            return False
        if st["modelActive"]:
            return True
        if st["rows"] >= st["minRows"]:
            return True
        return False

    def start(self, analyzer) -> bool:
        with self._lock:
            if self.state.get("state") == "running":
                return False
            self.state["state"] = "running"
            self.state["startedAt"] = now_ms()
            self.state["finishedAt"] = None
            self.state["error"] = None
            self.state["run"] = int(self.state.get("run", 0)) + 1
            self.state["trials"] = self.cfg.train_trials
            self.state["best"] = None
            self.state["lastTrial"] = None
            self._persist()
        thread = threading.Thread(target=self._run, args=(analyzer,), daemon=True)
        thread.start()
        return True

    def _run(self, analyzer) -> None:
        try:
            self._train(analyzer)
        except Exception as exc:  # noqa: BLE001
            self.state["state"] = "error"
            self.state["error"] = str(exc)
            self.state["finishedAt"] = now_ms()
            self.store.insert_training_run(
                started_at=int(self.state.get("startedAt") or now_ms()),
                finished_at=self.state["finishedAt"], state="error",
                rows=self.store.count_windows(), epochs=self.cfg.train_epochs,
                model_file=str(model_tflite_path(self.cfg)), error=str(exc))
            self._emit("training.error", run=int(self.state.get("run", 0)), error=str(exc))
            self._persist()

    def _sample_hp(self, rng: random.Random, fine_tune: bool) -> dict:
        hp = {
            "kind": rng.choice(self.runtime.train_kinds),
            "lr": rng.choice(self.runtime.train_lr),
            "batch": self.runtime.train_batch,
            "epochs": max(1, int(rng.choice([0.6, 0.8, 1.0]) * self.runtime.train_epochs)),
            "reg": rng.choice(self.runtime.train_reg),
        }
        if not fine_tune:
            hp.update({
                "units": rng.choice(self.runtime.train_units),
                "layers": rng.choice(self.runtime.train_layers),
                "dropout": rng.choice(self.runtime.train_dropout),
            })
        return hp

    @staticmethod
    def _reg(reg: float):
        import tensorflow as tf  # noqa: PLC0415

        if reg and reg > 0:
            return tf.keras.regularizers.l2(reg)
        return None

    @staticmethod
    def _describe(model) -> dict:
        """Extract architecture facts for model metadata (no TF internals besides counts)."""
        try:
            params = int(model.count_params())
        except Exception:  # noqa: BLE001
            params = 0
        configs = [getattr(layer, "get_config", lambda: {})() for layer in model.layers]
        has_dropout = any(cfg.get("name") == "dropout" for cfg in configs)
        hidden = [c.get("units") for c in configs if c.get("name") == "dense"][:-1]
        return {
            "params": params,
            "layers": [c.get("name") for c in configs],
            "hiddenUnits": [int(u) for u in hidden if u is not None],
            "dropout": has_dropout,
            "inputDim": model.input_shape[1] if getattr(model, "input_shape", None) else None,
        }

    def _train(self, analyzer) -> None:
        import tensorflow as tf  # noqa: PLC0415

        fine_tune = model_savedmodel_path(self.cfg).exists()
        features, labels = self.store.training_features(
            limit=None, since=self.runtime.watermark if fine_tune else None)
        if len(features) < 2 or len(labels) < 2:
            self.state["state"] = "done"
            self.state["finishedAt"] = now_ms()
            self._persist()
            self._emit("training.skipped", run=int(self.state.get("run", 0)),
                       newRows=len(features),
                       reason="no new windows since watermark")
            return
        x = np.asarray(features, dtype=np.float32)
        y = np.array([LABELS[l] for l in labels], dtype=np.int64)
        y_oh = np.zeros((len(y), 3), dtype=np.float32)
        y_oh[np.arange(len(y)), y] = 1.0

        run = int(self.state.get("run", 0))
        sm_path = model_savedmodel_path(self.cfg)
        fine_tune = sm_path.exists()
        self._emit("training.started", run=run, rows=int(x.shape[0]),
                   trials=self.runtime.train_trials, epochs=self.runtime.train_epochs,
                   fineTune=fine_tune, since=self.runtime.watermark)

        rng = random.Random(self.runtime.train_seed)
        trials = self.runtime.train_trials
        best: dict | None = None
        best_arch: dict | None = None
        t0 = time.time()

        for i in range(trials):
            hp = self._sample_hp(rng, fine_tune)
            reg = self._reg(hp.get("reg", 0.0))
            if fine_tune:
                model = tf.keras.models.load_model(sm_path)
                for layer in model.layers:
                    layer.trainable = True
            else:
                model = tf.keras.Sequential()
                model.add(tf.keras.layers.InputLayer(input_shape=(x.shape[1],)))
                if hp.get("kind") == "mlr":
                    # nominal logistic regression: softmax over raw features,
                    # no hidden layers (Keras initializer unused).
                    model.add(tf.keras.layers.Dense(
                        3, activation="softmax",
                        kernel_regularizer=reg,
                        kernel_initializer="random_normal"))
                else:
                    for _ in range(hp["layers"]):
                        model.add(tf.keras.layers.Dense(
                            hp["units"], activation="relu",
                            kernel_regularizer=reg))
                        if hp["dropout"] > 0:
                            model.add(tf.keras.layers.Dropout(hp["dropout"]))
                    model.add(tf.keras.layers.Dense(
                        3, activation="softmax", kernel_regularizer=reg))
            model.compile(
                optimizer=tf.keras.optimizers.Adam(learning_rate=hp["lr"]),
                loss="categorical_crossentropy",
                metrics=["accuracy"],
            )

            val_frac = float(self.runtime.train_validation) if len(x) >= 5 else 0.0
            split = int(len(x) * (1.0 - val_frac)) if val_frac > 0 else len(x)
            if split < 2 or (split < len(x) and len(x) - split < 1):
                raise RuntimeError(f"dataset too small for validation split ({len(x)})")
            idx = np.arange(len(x))
            rng.shuffle(idx)
            train_idx, val_idx = idx[:split], idx[split:]
            model.fit(
                x[train_idx], y_oh[train_idx],
                epochs=hp["epochs"], batch_size=hp["batch"],
                verbose=0,
            )
            y_pred = model.predict(x[val_idx], verbose=0).argmax(axis=1)
            metrics = mathlib.classification_metrics(y[val_idx], y_pred, n=3)
            metrics["epochs"] = hp["epochs"]
            metrics["valWindows"] = int(len(val_idx))

            is_best = best is None or (
                metrics["f1"] if metrics["f1"] > 0 else metrics["accuracy"]
            ) > (best["metrics"]["f1"] if best["metrics"]["f1"] > 0
                 else best["metrics"]["accuracy"])
            if is_best:
                best = {"config": hp, "metrics": metrics, "confusion": metrics["confusion"]}
                best_arch = self._describe(model)

            self.store.insert_training_run(
                started_at=int(self.state.get("startedAt") or now_ms()),
                finished_at=now_ms(), state="trial",
                rows=self.store.count_windows(), epochs=hp["epochs"],
                model_file=None, error=None,
                hp=hp, metrics=metrics, confusion=metrics["confusion"], best=is_best)
            self.state["lastTrial"] = {"hp": hp, "metrics": metrics}
            self.state["best"] = best
            self._persist()
            self._emit("training.progress", run=run, trial=i + 1,
                       trials=trials, config=hp, metrics=metrics,
                       confusion=metrics["confusion"],
                       bestSoFar=best and {"config": best["config"],
                                           "metrics": best["metrics"]})

        if best is None:
            raise RuntimeError("no trial produced valid metrics")

        model.save(sm_path)
        converter = tf.lite.TFLiteConverter.from_keras_model(model)
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        tflite_model = converter.convert()
        tm_path = model_tflite_path(self.cfg)
        tm_path.write_bytes(tflite_model)

        used_epochs = best["config"]["epochs"]
        watermark = self.store.training_max_window_start() or now_ms()
        train_seconds = round(time.time() - t0, 2)
        self.runtime.set_watermark(watermark)
        metadata = {
            "architecture": (best_arch or {}) | {
                "kind": best["config"].get("kind", "mlp"),
                "activation": "relu+softmax" if best["config"].get("kind") != "mlr" else "softmax",
                "regularizer": best["config"].get("reg") or 0.0,
            },
            "hparams": dict(best["config"]),
            "classes": LABEL_NAMES,
            "classCount": len(LABEL_NAMES),
            "metrics": dict(best["metrics"]),
            "confusion": best["confusion"],
            "featureFilter": list(self.runtime.feature_filter),
            "trainedUpTo": watermark,
            "trainSeconds": train_seconds,
            "trials": trials,
            "datasetRows": int(x.shape[0]),
            "fineTuned": bool(fine_tune),
        }
        self.store.upsert_model(
            name=self.cfg.model_name, kind="risk", enabled=True,
            filter_=list(self.runtime.feature_filter), sampling=None,
            metadata=metadata)
        self.state["state"] = "done"
        self.state["finishedAt"] = now_ms()
        self.state["rows"] = self.store.count_windows()
        self.state["modelFile"] = str(tm_path)
        self.state["best"] = best
        self.state["trainedUpTo"] = watermark
        self.state["trainSeconds"] = train_seconds
        self.state["modelMetadata"] = metadata
        self._persist()
        self.store.insert_training_run(
            started_at=int(self.state.get("startedAt") or now_ms()),
            finished_at=self.state["finishedAt"], state="done",
            rows=self.store.count_windows(), epochs=used_epochs,
            model_file=str(tm_path), error=None,
            hp=best["config"], metrics=best["metrics"],
            confusion=best["confusion"], best=True,
            watermark=watermark, seconds=train_seconds, metadata=metadata)
        self._emit("training.done", run=run, rows=self.store.count_windows(),
                   best=best, modelFile=str(tm_path),
                   tfliteBytes=tm_path.stat().st_size,
                   trainSeconds=train_seconds, watermark=watermark,
                   metadata=metadata)