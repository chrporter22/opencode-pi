"""Hold-out backtesting for the trained TF-Lite risk model.

Each run classifies stored window feature vectors with the current TFLite model
and writes per-window predictions (nnRisk + nnProb) plus the active model watermark
into a SEPARATE SQLite dataset (`backtest_samples`), summarized in `backtest_runs`.

Modes:
- `current`: backtest the current model over every stored window.
- `train`  : run a full training first (clearing stale locks via the orchestrator),
  then backtest the freshly exported model on windows strictly AFTER the
  pre-training watermark (the rows the previous model had never been trained on).
"""

from __future__ import annotations

import threading
import time

import numpy as np

from . import mathlib
from .config import Config
from .events import EventBus
from .runtime import RuntimeConfig
from .service import Analyzer
from .training import TrainingOrchestrator
from .warehouse import RedisStore, SqliteStore, now_ms, _unblob

LABELS = ["normal", "watch", "high"]


class Backtester:
    def __init__(self, cfg: Config, store: SqliteStore, redis: RedisStore,
                 events: EventBus | None = None, runtime: RuntimeConfig | None = None):
        self.cfg = cfg
        self.store = store
        self.redis = redis
        self.events = events or EventBus()
        self.runtime = runtime or RuntimeConfig(cfg, store)
        self._lock = threading.Lock()
        self._active = False

    def status(self) -> dict:
        runs = self.store.backtest_runs(1)
        return {"active": self._active, "last": runs[0] if runs else None}

    def _emit(self, type_: str, **extra) -> None:
        payload = dict(extra)
        payload["type"] = type_
        payload["timestamp"] = now_ms()
        self.events.emit(payload)

    def start(self, mode: str, analyzer: Analyzer, trainer: TrainingOrchestrator) -> bool:
        if mode not in ("current", "train"):
            mode = "current"
        with self._lock:
            if self._active:
                return False
            self._active = True
        thread = threading.Thread(
            target=self._run, args=(mode, analyzer, trainer), daemon=True)
        thread.start()
        return True

    def _run(self, mode: str, analyzer: Analyzer, trainer: TrainingOrchestrator) -> None:
        run_id = self.store.insert_backtest_run(mode, now_ms())
        self._emit("backtest.started", run=run_id, mode=mode)
        try:
            if mode == "train":
                self._train_then_backtest(run_id, analyzer, trainer)
            else:
                self._backtest_range(run_id, since=None, analyzer=analyzer)
        except Exception as exc:  # noqa: BLE001
            self.store.finish_backtest_run(run_id, "error", error=str(exc))
            self._emit("backtest.error", run=run_id, error=str(exc))
        finally:
            self._active = False

    def _train_then_backtest(self, run_id: int, analyzer: Analyzer,
                             trainer: TrainingOrchestrator) -> None:
        # wait out any in-flight training so we never stack two full runs
        deadline = time.time() + 30 * 60
        while trainer.status()["state"] == "running" and time.time() < deadline:
            time.sleep(3)
        w0 = self.runtime.watermark
        started = trainer.start(analyzer, mode="full")
        if not started:
            raise RuntimeError("could not start training for train & backtest"
                               " (training may still be in flight)")
        deadline = time.time() + 60 * 60
        while time.time() < deadline:
            st = trainer.status()
            if st["state"] == "done":
                break
            if st["state"] == "error":
                raise RuntimeError("training failed: " + str(st.get("error") or "unknown"))
            time.sleep(3)
        else:
            raise RuntimeError("training did not finish in time")
        self._backtest_range(run_id, since=w0, analyzer=analyzer)

    def _backtest_range(self, run_id: int, since: int | None, analyzer: Analyzer) -> None:
        analyzer.nn.reset()
        if not analyzer._model_active():  # noqa: SLF001
            raise RuntimeError("no active tflite model — train or repair the model first")
        model_watermark = self.runtime.watermark
        rows = self.store.backtest_windows(since=since)
        if not rows:
            raise RuntimeError("no windows with a feature vector to backtest"
                               + (" after the training watermark" if since is not None else ""))
        done = 0
        skipped = 0
        correct = 0
        wmin: int | None = None
        wmax: int | None = None
        truths: list[int] = []
        preds: list[int] = []
        total = len(rows)
        self._emit("backtest.progress", run=run_id, done=0, total=total, since=since)
        for ws, actual, fv in rows:
            vec = _unblob(fv)
            if vec is None:
                skipped += 1
                continue
            result = analyzer.nn.classify(vec)
            if result is None:
                skipped += 1
                continue
            nn_risk = result["nnRisk"]
            nn_prob = result["nnProb"]
            m = int(actual is not None and actual == nn_risk)
            correct += m
            preds.append(LABELS.index(nn_risk) if nn_risk in LABELS else -1)
            truths.append(LABELS.index(actual) if actual in LABELS else -1)
            self.store.insert_backtest_sample(
                run_id, ws, actual, nn_risk, nn_prob, model_watermark)
            wmin = ws if wmin is None else min(wmin, ws)
            wmax = ws if wmax is None else max(wmax, ws)
            done += 1
            if done % 250 == 0:
                self._emit("backtest.progress", run=run_id, done=done, total=total, since=since)
        if skipped == total:
            raise RuntimeError("model could not classify any window (input mismatch or no model)")
        yt = np.array([t for t in truths if t >= 0], dtype=np.int64)
        yp = np.array([p for p, t in zip(preds, truths) if t >= 0], dtype=np.int64)
        if yt.size:
            metrics = mathlib.classification_metrics(yt, yp, n=3)
        else:
            metrics = {"accuracy": None, "precision": None, "recall": None, "f1": None}
        self.store.finish_backtest_run(
            run_id, "done",
            model_watermark=model_watermark,
            window_from=wmin, window_to=wmax,
            rows=done, correct=correct,
            accuracy=metrics.get("accuracy"),
            precision=metrics.get("precision"),
            recall=metrics.get("recall"),
            f1=metrics.get("f1"),
            metadata={"skipped": skipped, "since": since},
        )
        self._emit("backtest.done", run=run_id, rows=done, correct=correct,
                   accuracy=metrics.get("accuracy"), f1=metrics.get("f1"),
                   since=since, modelWatermark=model_watermark)