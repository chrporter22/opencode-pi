"""Real tensorflow training loop + TFLite inference end-to-end.

Gated behind ANALYTICS_ML_E2E=1 so the routine suite stays fast; the CI/live
deploy runs it once to confirm the write-back chain (train -> export -> models
row + training_runs + watermark -> live classify) works.
"""

import os

import numpy as np
import pytest

from app.config import model_savedmodel_path, model_tflite_path
from app.events import EventBus
from app.runtime import RuntimeConfig
from app.training import TrainingOrchestrator
from app.warehouse import RedisStore, SqliteStore
from tests.test_service import make_cfg, make_payload  # noqa: PLC2701

pytestmark = pytest.mark.skipif(
    os.getenv("ANALYTICS_ML_E2E") != "1",
    reason="set ANALYTICS_ML_E2E=1 to run the real TF train+infer loop",
)


def test_train_then_classify_roundtrip(tmp_path):
    cfg = make_cfg(tmp_path)
    cfg = type(cfg)(**{**cfg.__dict__, "train_min_rows": 1, "train_epochs": 2})
    store = SqliteStore(cfg.db_file)
    redis = RedisStore(None, enabled=False)
    events = EventBus()
    runtime = RuntimeConfig(cfg, store)
    analyzer = __import__("app.service", fromlist=["Analyzer"]).Analyzer(
        cfg, store, redis, events=events, runtime=runtime)

    # deterministic, separable classes so the model actually learns something
    base = 4_000_000_000_000
    for i in range(12):
        drift = 0.6 if i >= 6 else 0.0
        payload = make_payload(i, base)
        payload["features"] = [
            (1.0 + drift + i * 0.01) * v if idx < 4 else v
            for idx, v in enumerate(payload["features"])
        ]
        analyzer.ingest(payload)

    # force a small mlr tuning budget so the run is fast
    cfg2 = type(cfg)(**{**cfg.__dict__, "train_trials": 1, "train_validation": 0.3})
    runtime.save({"train": {
        "minRows": 1, "epochs": 2, "trials": 1, "validation": 0.3,
        "lrChoices": [1e-3], "kinds": ["mlr"], "regChoices": [0.0],
    }})
    trainer = TrainingOrchestrator(cfg2, store, redis, events=events, runtime=runtime)

    assert trainer.should_train() is True  # model absent, rows >= 1

    training_done = []
    events.subscribe(lambda rec: training_done.append(rec) if rec.get("type") == "training.done" else None)
    trainer._train(analyzer)  # noqa: SLF001  (synchronous, deterministic)

    tm = model_tflite_path(cfg2)
    sm = model_savedmodel_path(cfg2)
    assert sm.exists() and tm.exists()

    done = training_done[-1]
    assert done["modelFile"] == str(tm)
    assert done["metadata"]["fineTuned"] is False
    assert done["watermark"] == store.training_max_window_start()

    active = store.get_active_risk_model()
    assert active is not None
    assert active["metadata"]["datasetRows"] >= 5
    assert active["metadata"]["confusion"] is not None
    assert active["metadata"]["trainSeconds"] is not None

    last = store.training_runs(limit=1)[0]
    assert last["state"] == "done"
    assert last["best"] is True
    assert last["metadata"]["hparams"]["kind"] == "mlr"

    assert trainer.status()["state"] == "done"
    assert trainer.status()["trainedUpTo"] == done["watermark"]

    # live inference on the latest stored window via the mtime-cached classifier
    analyzer.nn.reset()
    result = analyzer.infer_now()
    assert result is not None
    assert result["nnRisk"] in {"normal", "watch", "high"}
    assert len(result["nnProb"]) == 3
    assert abs(sum(result["nnProb"]) - 1.0) < 1e-3


def test_fine_tune_incremental_uses_new_rows_only(tmp_path):
    cfg = make_cfg(tmp_path)
    store = SqliteStore(cfg.db_file)
    redis = RedisStore(None, enabled=False)
    events = EventBus()
    runtime = RuntimeConfig(cfg, store)
    analyzer = __import__("app.service", fromlist=["Analyzer"]).Analyzer(
        cfg, store, redis, events=events, runtime=runtime)
    runtime.save({"train": {
        "minRows": 1, "epochs": 1, "trials": 1, "validation": 0.3,
        "lrChoices": [1e-3], "kinds": ["mlr"], "regChoices": [0.0],
    }})

    base = 4_100_000_000_000
    for i in range(8):
        analyzer.ingest(make_payload(i, base))
    latest = store.training_max_window_start()

    trainer = TrainingOrchestrator(cfg, store, redis, events=events, runtime=runtime)
    trainer._train(analyzer)  # noqa: SLF001  initial build
    assert trainer.status()["modelActive"] is True

    trainer.runtime.set_watermark(latest)
    seen = []
    events.subscribe(lambda rec: seen.append(rec) if rec.get("type") == "training.progress" else None)
    trainer._train(analyzer)  # noqa: SLF001  fine-tune with zero new rows
    assert trainer.status()["state"] == "idle"
    assert seen == []  # no trials ran: no new rows past the watermark

    # new window after the watermark -> incremental run consumes exactly it
    analyzer.ingest(make_payload(8, base))
    trainer._train(analyzer)  # noqa: SLF001  fine-tune with 1 new row -> too few
    assert trainer.status()["state"] == "idle"

    for i in range(9, 15):
        analyzer.ingest(make_payload(i, base))
    after = store.new_training_rows(latest)
    assert after >= 6
    trainer._train(analyzer)  # noqa: SLF001
    assert trainer.status()["state"] == "done"
    assert trainer.status()["trainedUpTo"] == store.training_max_window_start()
    meta = store.get_active_risk_model()["metadata"]
    assert meta is not None and meta["fineTuned"] is True
    assert meta["trainedUpTo"] == store.training_max_window_start()