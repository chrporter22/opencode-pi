"""Live risk classification with the trained TFLite model.

Lazy-imports tensorflow and caches the interpreter until the artifact changes
(mtime). The active risk model only: if a trained `{model_name}.tflite`
artifact exists, each input window (the masked feature vector dimension the
model was built on) is classified to `normal | watch | high` with softmax
probabilities, merged into the live `analytics.risk` event for SSE/WS render.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .config import Config, model_tflite_path
from .training import LABEL_NAMES


def _tf():
    import tensorflow as tf  # noqa: PLC0415, F401

    return tf


class TFLiteClassifier:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._interp = None
        self._mtime: float | None = None

    def reset(self) -> None:
        self._interp = None
        self._mtime = None

    def _build(self) -> None:
        path = model_tflite_path(self.cfg)
        if not path.exists() or path.stat().st_size < 1:
            self._interp = None
            self._mtime = None
            return
        # tensorflow import is heavy; keep it lazy and once-only per process
        tf = _tf()
        interp = tf.lite.Interpreter(model_path=str(path))
        detail = interp.get_input_details()[0]
        if detail.get("dtype") is None:
            raise RuntimeError(f"tflite input missing dtype: {path}")
        interp.allocate_tensors()
        self._interp = interp
        self._mtime = path.stat().st_mtime

    def classify(self, x: np.ndarray) -> dict | None:
        path = model_tflite_path(self.cfg)
        if not path.exists() or path.stat().st_size < 1:
            self.reset()
            return None
        mtime = path.stat().st_mtime
        if self._interp is None or self._mtime != mtime:
            self._build()
        if self._interp is None:
            return None
        detail = self._interp.get_input_details()[0]
        expected = int(detail["shape"][1])
        if x.size != expected:
            return None
        import time  # noqa: PLC0415

        t0 = time.time()
        self._interp.set_tensor(detail["index"], np.asarray(x, dtype=np.float32)[None, :])
        self._interp.invoke()
        out = self._interp.get_tensor(self._interp.get_output_details()[0]["index"])
        probs = np.asarray(out, dtype=float).reshape(-1)
        if probs.size != len(LABEL_NAMES):
            probs = probs[-len(LABEL_NAMES):]
        probs = np.clip(probs, 0.0, None)
        total = probs.sum()
        if total <= 0:
            return None
        probs = probs / total
        label = LABEL_NAMES[int(np.argmax(probs))]
        return {
            "nnRisk": label,
            "nnProb": [float(p) for p in probs],
            "nnLatencyMs": round((time.time() - t0) * 1000, 2),
        }