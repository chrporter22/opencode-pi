from __future__ import annotations

from collections import deque

import numpy as np

from . import mathlib
from .config import Config
from .events import EventBus
from .features import FEATURE_NAMES, REQUEST_FEATURE_NAMES
from .nn import TFLiteClassifier
from .runtime import RuntimeConfig
from .warehouse import RedisStore, SqliteStore, now_ms

MAX_TOP_LOADINGS = 3


class ScoreRecord(dict):
    pass


def _pca_summary(window_start: int, ts: int, loadings: np.ndarray,
                 eigen: np.ndarray, scores: np.ndarray, pcz: np.ndarray,
                 level: str, t2: float, p_value: float, mu: np.ndarray,
                 std: np.ndarray, compute_ms: float, windows_scored: int,
                 model_active: bool, context_windows: int, context_cap: int) -> ScoreRecord:
    total = float(eigen.sum()) if eigen.size else 0.0
    variance = [float(e) / total if total > 0 else 0.0 for e in eigen]
    return ScoreRecord({
        "type": "analytics.risk",
        "projection": scores.tolist(),
        "components": loadings.tolist(),
        "variance": variance,
        "eigenvalues": [float(e) for e in eigen],
        "totalVariance": total,
        "mean": mu.tolist(),
        "std": std.tolist(),
        "drift": t2,
        "driftClassification": level,
        "risk": level,
        "confidence": max(0.0, min(1.0, 1.0 - p_value)) if p_value is not None else None,
        "heartbeat": ts,
        "lastRun": window_start,
        "level": level,
        "t2": t2,
        "pValue": p_value,
        "computeMs": compute_ms,
        "windowsScored": windows_scored,
        "contextWindows": context_windows,
        "contextCap": context_cap,
        "modelActive": model_active,
        "pcScores": [
            {"i": i, "z": float(z), "value": float(v)}
            for i, (z, v) in enumerate(zip(pcz, scores[-1]))
        ],
    })


class Analyzer:
    """Live window scorer: ingest → feature filter → EWMA/PCA + TFLite NN.

    Every scored window emits an `analytics.risk` event (PcaSummary shape with
    `nnRisk`/`nnProb`/`nnLatencyMs` merged once a trained model is active).
    Analysis always runs on the *filtered* feature subset, so changing the
    feature mask or the EWMA/context knobs cleanly resets the reference.
    """

    def __init__(self, cfg: Config, store: SqliteStore, redis: RedisStore,
                 events: EventBus | None = None, runtime: RuntimeConfig | None = None):
        self.cfg = cfg
        self.store = store
        self.redis = redis
        self.events = events or EventBus()
        self.runtime = runtime or RuntimeConfig(cfg, store)
        self.nn = TFLiteClassifier(cfg)
        self.context: deque[np.ndarray] = deque(maxlen=self.runtime.context_windows)
        self.latest_score: dict | None = redis.get_score() or store.latest_window()
        self.reference = mathlib.EwmaReference(0, self.runtime.ewma_decay)
        self._nn_count = 0
        self._nn_total = 0
        self._sig: tuple | None = None
        self._rehydrate_reference()

    def _rehydrate_reference(self) -> None:
        loaded = self.store.load_reference()
        if loaded is None:
            return
        mu, s2, n = loaded
        if self.reference.dim == 0:
            self.reference = mathlib.EwmaReference(int(mu.size), self.runtime.ewma_decay)
        self.reference.load(mu, s2, n)

    def _check_reset(self) -> None:
        sig = (
            tuple(self.runtime.feature_filter),
            self.runtime.ewma_decay,
            self.runtime.context_windows,
        )
        if sig != self._sig:
            self._sig = sig
            self.reference = mathlib.EwmaReference(
                self.runtime.filtered_dim, self.runtime.ewma_decay)
            self.context = deque(maxlen=self.runtime.context_windows)
            self.latest_score = None
            if self.runtime.filtered_dim:
                self.reference = mathlib.EwmaReference(
                    self.runtime.filtered_dim, self.runtime.ewma_decay)

    def _ensure_dim(self, dim: int) -> None:
        if self.reference.dim != dim:
            self.reference = mathlib.EwmaReference(dim, self.runtime.ewma_decay)
            self.context.clear()

    def _model_active(self) -> bool:
        if self.nn._interp is not None:  # noqa: SLF001
            return True
        from .config import model_tflite_path  # noqa: PLC0415

        path = model_tflite_path(self.cfg)
        return path.exists() and path.stat().st_size >= 1

    def _classify(self, xf: np.ndarray) -> dict | None:
        if not self._model_active():
            return None
        row = None
        for m in self.store.list_models():
            if m["kind"] == "risk":
                row = m
                break
        if row is not None and not row["enabled"]:
            return None
        window_every = None
        if row and row.get("sampling") and row["sampling"].get("windowEvery"):
            try:
                window_every = int(row["sampling"]["windowEvery"])
            except (TypeError, ValueError):
                window_every = None
        if window_every and window_every > 0:
            self._nn_count += 1
            if self._nn_count % window_every != 0:
                return None
        try:
            result = self.nn.classify(xf)
            if result is not None:
                self._nn_total += 1
            return result
        except Exception:  # noqa: BLE001
            return None

    def apply_settings(self, doc: dict | None) -> dict:
        """Persist + live-apply a config patch from the dashboard."""
        self.runtime.save(doc or {})
        self._check_reset()
        self.nn.reset()
        return self.runtime.effective()

    def ingest(self, payload: dict) -> ScoreRecord | None:
        if not self.runtime.ingest_enabled:
            return None
        window_start = int(payload.get("windowStart", now_ms()))
        features = payload.get("features") or []
        if not features:
            return None
        x = np.asarray(features, dtype=float)
        self._check_reset()

        for rec in payload.get("requests") or []:
            started_at = int(rec.get("startedAt", window_start))
            rfeat = rec.get("features")
            self.store.insert_request(
                started_at=started_at,
                error=1 if rec.get("error") else 0,
                feature_vec=np.asarray(rfeat, dtype=float) if rfeat else None,
            )

        mask = np.array(self.runtime.feature_filter, dtype=bool)
        xf = x[mask]
        self._ensure_dim(int(xf.size))
        if self.reference.dim == 0:
            return None

        t0 = now_ms()
        z = self.reference.update(xf)
        self.context.append(z)

        level: str | None = None
        t2: float | None = None
        p_value: float | None = None
        pcs = None
        loadings = None
        eigen = None
        scores = None
        context_arr = np.vstack(list(self.context)) if self.context else None

        if len(self.context) >= 2 and self.reference.n >= 2:
            pca = mathlib.compute_pca(context_arr, self.runtime.pca_components)
            if pca is not None:
                loadings, eigen, scores = pca
                pcz = scores[-1] / np.sqrt(np.maximum(eigen, 1e-8))
                t2, p_value = mathlib.hotelling(pcz)
                if self.runtime.label_mode == "z_score":
                    level = mathlib.risk_label(pcz, self.runtime.watch_z, self.runtime.high_z)
                else:
                    level = mathlib.label_from_p(
                        p_value, self.runtime.label_p_watch, self.runtime.label_p_high)
                pcs = pcz

        compute_ms = float(now_ms() - t0)
        nn = self._classify(xf) if level is not None else None
        self.store.insert_window(
            window_start=window_start,
            feature_vec=xf,
            context=context_arr,
            pcs=pcs,
            loadings=loadings,
            eigen=eigen,
            risk=level,
            t2=t2,
            p_value=p_value,
            compute_ms=compute_ms,
            created_at=now_ms(),
            nn_latency_ms=nn.get("nnLatencyMs") if nn else None,
            nn_risk=nn.get("nnRisk") if nn else None,
            nn_prob=nn.get("nnProb") if nn else None,
            z=z,
        )
        self.store.save_reference(self.reference.mu, self.reference.s2,
                                  self.reference.n, now_ms())

        if level is not None:
            record = _pca_summary(
                window_start=window_start,
                ts=now_ms(),
                loadings=loadings,
                eigen=eigen,
                scores=scores,
                pcz=pcs,
                level=level,
                t2=t2,
                p_value=p_value,
                mu=self.reference.mu,
                std=self.reference.sigma(),
                compute_ms=compute_ms,
                windows_scored=self.reference.n,
                model_active=self._model_active(),
                context_windows=len(self.context),
                context_cap=self.runtime.context_windows,
            )
            if nn:
                record.update(nn)
            self.latest_score = record
            self.redis.set_score(record)
            self.events.emit(record)
            return record
        return None

    def risk(self) -> dict:
        if self.latest_score is not None:
            return dict(self.latest_score)
        return {"level": None, "risk": None, "windowsScored": self.reference.n,
                "contextWindows": len(self.context),
                "contextCap": self.runtime.context_windows}

    def pca_summary(self) -> dict:
        if self.latest_score is not None:
            return dict(self.latest_score)
        return {"risk": None, "windowsScored": self.reference.n,
                "contextWindows": len(self.context),
                "contextCap": self.runtime.context_windows}

    def history(self, limit: int = 120) -> list[dict]:
        rows = self.store.history_windows(limit)
        out = []
        for r in rows:
            pcs = r["pcs"] if isinstance(r["pcs"], np.ndarray) else np.asarray(r["pcs"], dtype=float)
            out.append({
                "timestamp": int(r["window_start"]),
                "projection": [pcs.tolist()],
                "drift": r["t2"] or 0.0,
                "risk": r["risk"],
            })
        return out

    def _feature_names(self) -> list[str]:
        mask = np.array(self.runtime.feature_filter, dtype=bool)
        return [name for name, flag in zip(FEATURE_NAMES, mask) if flag]

    def pca_cloud(self, limit: int = 300) -> list[dict]:
        rows = self.store.pca_cloud(limit)
        names = self._feature_names()
        for row in rows:
            row["featureNames"] = names
        return rows

    def raw_windows(self, limit: int = 25) -> list[dict]:
        rows = self.store.raw_windows(limit)
        names = self._feature_names()
        for row in rows:
            row["featureNames"] = names
        return rows

    def raw_requests(self, limit: int = 25) -> list[dict]:
        rows = self.store.raw_requests(limit)
        for row in rows:
            row["featureNames"] = list(REQUEST_FEATURE_NAMES)
        return rows

    def latency_history(self, limit: int = 120) -> list[dict]:
        return self.store.latency_history(limit)

    def infer_now(self) -> dict | None:
        """Manual TF-lite inference on the latest stored window (bypasses sampling)."""
        row = self.store.conn.execute(
            "SELECT window_start, feature_vec FROM windows ORDER BY window_start DESC LIMIT 1"
        ).fetchone()
        if row is None or not row[1]:
            return None
        xf = np.frombuffer(bytes(row[1]), dtype=">f4").astype(float)
        if xf.size == 0:
            return None
        result = self.nn.classify(xf)
        if not result:
            return None
        result = dict(result)
        result["type"] = "analytics.infer"
        result["timestamp"] = now_ms()
        result["onWindowStart"] = int(row[0])
        self.events.emit(result)
        return result

    def live_score(self, features: list[float] | None) -> dict | None:
        """TF-lite inference on a live feature vector from the gateway.

        Unlike :meth:`ingest`, nothing is written: no EWMA update, no reference,
        no windows, no training rows. Pure read-only classify on each incoming
        tele sample, emitted as ``analytics.infer`` with ``source="live"``.
        """
        if not features:
            return None
        if not self._model_active():
            return None
        x = np.asarray(features, dtype=float).ravel()
        if x.size == 0:
            return None
        mask = np.array(self.runtime.feature_filter, dtype=bool)
        if x.size == len(FEATURE_NAMES):
            xf = x[mask]
        elif x.size == int(mask.sum()):
            xf = x
        else:
            return None
        if xf.size == 0:
            return None
        result = self.nn.classify(xf)
        if not result:
            return None
        result = dict(result)
        result["type"] = "analytics.infer"
        result["timestamp"] = now_ms()
        result["source"] = "live"
        self.events.emit(result)
        return result

    def meta(self) -> dict:
        """Meta metrics for the dashboard: model info, latency, system snapshot,
        and the exact input vector currently feeding the model."""
        from .cron import Cron  # noqa: PLC0415
        from .config import model_savedmodel_path, model_tflite_path  # noqa: PLC0415

        mask = np.array(self.runtime.feature_filter, dtype=bool)
        active_names = [name for name, flag in zip(FEATURE_NAMES, mask) if flag]
        inputs: list[dict] = []
        row = self.store.conn.execute(
            "SELECT feature_vec FROM windows ORDER BY window_start DESC LIMIT 1"
        ).fetchone()
        if row and row[0]:
            feats = np.frombuffer(bytes(row[0]), dtype=">f4").astype(float)
            inputs = [
                {"name": name, "value": round(float(value), 4)}
                for name, value in zip(active_names, feats)
            ]
        look = {item["name"]: item["value"] for item in inputs}
        avg_row = self.store.conn.execute(
            "SELECT AVG(compute_ms) FROM (SELECT compute_ms FROM windows"
            " WHERE compute_ms IS NOT NULL ORDER BY id DESC LIMIT 50)"
        ).fetchone()

        tflite = model_tflite_path(self.cfg)
        keras = model_savedmodel_path(self.cfg)
        cron = Cron(self.runtime.cron)
        latest = self.latest_score or {}
        return {
            "type": "analytics.meta",
            "timestamp": now_ms(),
            "ingestEnabled": self.runtime.ingest_enabled,
            "windows": self.store.count_windows(),
            "requests": self.store.count_requests(),
            "dim": self.reference.dim,
            "referenceN": self.reference.n,
            "context": {"count": len(self.context), "cap": self.runtime.context_windows},
            "thresholds": {"watchZ": self.runtime.watch_z, "highZ": self.runtime.high_z},
            "inputFeatures": inputs,
            "inputFilter": [{"name": name, "enabled": bool(flag)}
                            for name, flag in zip(FEATURE_NAMES, mask)],
            "system": {
                "cpuFrac": look.get("cpuFrac"),
                "memFrac": look.get("memFrac"),
                "tempC": look.get("tempC"),
                "diskFrac": look.get("diskFrac"),
            },
            "model": {
                "active": tflite.exists(),
                "tfliteBytes": tflite.stat().st_size if tflite.exists() else None,
                "kerasBytes": keras.stat().st_size if keras.exists() else None,
                "name": self.cfg.model_name,
            },
            "latency": {
                "lastNnMs": latest.get("nnLatencyMs"),
                "lastComputeMs": latest.get("computeMs"),
                "avgComputeMs": round(float(avg_row[0]), 3) if avg_row and avg_row[0] is not None else None,
                "nnRuns": self._nn_total,
            },
            "risk": {"level": latest.get("level"), "nnRisk": latest.get("nnRisk"),
                     "confidence": latest.get("confidence"),
                     "totalVariance": latest.get("totalVariance")},
            "cron": self.runtime.cron,
            "nextRun": cron.next_run_ms(),
            "watermark": self.runtime.watermark,
        }

    def reference_snapshot(self) -> dict:
        return {
            "n": self.reference.n,
            "dim": self.reference.dim,
            "mu": self.reference.mu.tolist() if self.reference.dim else [],
            "sigma": self.reference.sigma().tolist() if self.reference.dim else [],
        }

    def rebaseline(self) -> dict:
        """Recompute the EWMA/PCA reference from stored windows (fresh fit)."""
        rows = self.store.conn.execute(
            "SELECT feature_vec FROM windows ORDER BY window_start ASC"
        ).fetchall()
        mats = [np.frombuffer(bytes(r[0]), dtype=">f4") for r in rows if r[0]]
        vectors = [m.astype(float) for m in mats if m.size > 0]
        if not vectors:
            return {"ok": False, "windows": 0}
        data = np.vstack(vectors)
        dim = int(data.shape[1])
        self._check_reset()
        self._ensure_dim(dim)
        mu = data.mean(axis=0)
        s2 = (data * data).mean(axis=0)
        self.reference.load(mu, s2, int(data.shape[0]))
        zs = (data - mu) / np.maximum(np.sqrt(np.maximum(s2 - mu * mu, 1e-8)), 1e-8)
        self.context = deque(zs[-self.runtime.context_windows:],
                             maxlen=self.runtime.context_windows)
        self.store.save_reference(self.reference.mu, self.reference.s2,
                                  self.reference.n, now_ms())
        self.events.emit({"type": "analytics.rebaseline",
                          "timestamp": now_ms(), "windows": int(data.shape[0])})
        return {"ok": True, "windows": int(data.shape[0]), "dim": dim}