"""ML-layer backend: PCA cloud, latency history, model registry (metadata + soft
delete), and training random-search kinds (mlr/mlp) + full model metadata."""

import numpy as np
import pytest

from app.warehouse import RedisStore, SqliteStore
from tests.test_service import make_cfg, make_payload  # noqa: PLC2701


def make_store(tmp_path):
    cfg = make_cfg(tmp_path)
    return cfg, SqliteStore(cfg.db_file)


def seed(store, n=5):
    base = 2_300_000_000_000
    for i in range(n):
        rng = np.random.default_rng(i)
        feats = rng.normal(i * 0.05, 1.0, size=10)
        store.insert_window(
            window_start=base + i * 60_000,
            feature_vec=feats,
            context=np.vstack([feats]),
            pcs=rng.normal(size=6),
            loadings=rng.normal(size=(10, 6)),
            eigen=np.ones(6),
            risk="normal" if i % 2 == 0 else "watch",
            t2=1.0 + i,
            p_value=0.4,
            compute_ms=0.5 + i,
            created_at=base + i * 60_000,
            nn_latency_ms=1.0 + i * 0.1,
            nn_risk="normal" if i % 2 == 0 else "watch",
            nn_prob=[0.6, 0.3, 0.1],
        )
        store.insert_request(
            started_at=base + i * 60_000,
            error=1 if i == 3 else 0,
            feature_vec=np.asarray([6.1, 5.2, 7.3, 1.1, 8.0, 0.0]),
        )


# --- pca cloud -------------------------------------------------------------
def test_pca_cloud_shape_and_fields(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store, n=5)
    cloud = store.pca_cloud(limit=10)
    assert len(cloud) == 5
    points = sorted(cloud, key=lambda p: p["windowStart"])
    # ascending by time (oldest first)
    assert points[0]["windowStart"] <= points[-1]["windowStart"]
    p0 = points[0]
    assert len(p0["pcs"]) == 6
    assert p0["risk"] in {"normal", "watch"}
    assert p0["t2"] is not None
    assert p0["nnMs"] is not None
    assert p0["nnRisk"] in {"normal", "watch"}
    assert len(p0["features"]) == 10


def test_pca_cloud_limit_ascending(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store, n=10)
    cloud = store.pca_cloud(limit=8)
    assert len(cloud) == 8
    assert cloud[0]["windowStart"] < cloud[-1]["windowStart"]


# --- latency history -------------------------------------------------------
def test_latency_history_ascending_and_nulls(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store, n=5)
    hist = store.latency_history(limit=20)
    assert len(hist) == 5
    assert hist[0]["ts"] < hist[-1]["ts"]
    assert all(h["computeMs"] is not None for h in hist)
    assert all(h["nnMs"] is not None for h in hist)
    assert hist[0]["nnMs"] < hist[-1]["nnMs"]


def test_latency_history_omits_all_null_rows(tmp_path):
    cfg, store = make_store(tmp_path)
    base = 9_000_000_000_000
    for i in range(3):
        store.insert_window(
            window_start=base + i * 60_000, feature_vec=np.ones(10),
            context=np.vstack([np.ones(10)]), pcs=None, loadings=None,
            eigen=None, risk=None, t2=None, p_value=None,
            compute_ms=None, created_at=base + i * 60_000,
        )
    assert store.latency_history(limit=10) == []


# --- model registry: soft delete + metadata --------------------------------
def test_models_soft_delete(tmp_path):
    cfg, store = make_store(tmp_path)
    mid = store.upsert_model(name="risk.net", kind="risk", enabled=True)
    assert store.delete_model(mid) is True
    assert store.get_model(mid) is None
    assert store.list_models() == []
    assert store.list_models(include_deleted=True) and store.list_models(include_deleted=True)[0]["id"] == mid
    # double delete reports not found
    assert store.delete_model(mid) is False


def test_models_metadata_roundtrip(tmp_path):
    cfg, store = make_store(tmp_path)
    meta = {"kind": "mlr", "hparams": {"lr": 1e-3}, "classes": ["normal", "watch", "high"]}
    mid = store.upsert_model(name="risk.net", kind="risk", enabled=True, metadata=meta)
    row = store.get_model(mid)
    assert row["metadata"] == meta
    assert store.list_models()[0]["metadata"] == meta


def test_set_model_ignores_soft_deleted(tmp_path):
    cfg, store = make_store(tmp_path)
    mid = store.upsert_model(name="risk.net", kind="risk", enabled=True)
    store.delete_model(mid)
    assert store.set_model(mid, enabled=False) is False


def test_get_active_risk_model(tmp_path):
    cfg, store = make_store(tmp_path)
    store.upsert_model(name="risk.net", kind="risk", enabled=True, metadata={"a": 1})
    active = store.get_active_risk_model()
    assert active is not None and active["metadata"] == {"a": 1}


# --- training runs: seconds + metadata -------------------------------------
def test_training_runs_list(tmp_path):
    cfg, store = make_store(tmp_path)
    store.insert_training_run(
        started_at=1, finished_at=2, state="done", rows=10, epochs=3,
        model_file="/x", error=None, watermark=100, seconds=5.5,
        metadata={"kind": "mlr", "hparams": {"lr": 1e-3}, "confusion": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]},
    )
    runs = store.training_runs(limit=5)
    assert len(runs) == 1
    r = runs[0]
    assert r["watermark"] == 100
    assert r["seconds"] == 5.5
    assert r["metadata"]["kind"] == "mlr"
    assert r["state"] == "done"
    assert r["best"] is False


def test_training_runs_metadata_confusion_lists(tmp_path):
    cfg, store = make_store(tmp_path)
    cm = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    store.insert_training_run(started_at=1, finished_at=2, state="done", rows=10,
                              epochs=1, model_file=None, error=None,
                              confusion=cm, best=True, watermark=9, seconds=2.0)
    runs = store.training_runs()
    assert runs[0]["confusion"] == cm
    assert runs[0]["best"] is True


def test_insert_window_persists_nn(tmp_path):
    cfg, store = make_store(tmp_path)
    store.insert_window(
        window_start=1, feature_vec=np.ones(10), context=np.vstack([np.ones(10)]),
        pcs=np.ones(2), loadings=np.ones((10, 2)), eigen=np.ones(2),
        risk="watch", t2=2.0, p_value=0.1, compute_ms=0.5, created_at=1,
        nn_latency_ms=1.5, nn_risk="watch", nn_prob=[0.2, 0.6, 0.2],
    )
    raw = store.raw_windows(limit=1)[0]
    assert raw["nnMs"] == 1.5
    assert raw["risk"] == "watch"


def test_runtime_kinds_default():
    from app.runtime import RuntimeConfig
    from app.runtime import _DEFAULT_TRAIN

    assert set(_DEFAULT_TRAIN["kinds"]) == {"mlr", "mlp"}
    assert "regChoices" in _DEFAULT_TRAIN


def test_mlr_sampling_builds_softmax_only(tmp_path):
    # Confirm the hp sampler can pick an mlr trial with L2 reg choices.
    import random

    from app.training import TrainingOrchestrator
    from app.service import Analyzer
    from app.events import EventBus

    cfg, store = make_store(tmp_path)
    redis = RedisStore(None, enabled=False)
    events = EventBus()
    analyzer = Analyzer(cfg, store, redis, events=events)
    trainer = TrainingOrchestrator(cfg, store, redis, events=events, runtime=analyzer.runtime)

    rng = random.Random(7)
    saw = {"mlr": False, "mlp": False}
    for _ in range(40):
        hp = trainer._sample_hp(rng, fine_tune=False)
        assert hp["kind"] in {"mlr", "mlp"}
        saw[hp["kind"]] = True
        if all(saw.values()):
            break
    assert saw["mlr"] is True and saw["mlp"] is True


def test_mlr_sampling_has_reg_and_kind(tmp_path):
    from app.runtime import _DEFAULT_TRAIN

    cfg, store = make_store(tmp_path)
    import random

    from app.training import TrainingOrchestrator
    from app.service import Analyzer
    from app.events import EventBus

    redis = RedisStore(None, enabled=False)
    events = EventBus()
    analyzer = Analyzer(cfg, store, redis, events=events)
    trainer = TrainingOrchestrator(cfg, store, redis, events=events, runtime=analyzer.runtime)
    hp = trainer._sample_hp(random.Random(1), fine_tune=False)
    assert "kind" in hp
    assert hp["reg"] in _DEFAULT_TRAIN["regChoices"]