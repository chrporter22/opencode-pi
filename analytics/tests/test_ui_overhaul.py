"""UI-overhaul data contract: per-window z-scores, featureNames enrichment,
incremental-training gating, and the warehouse counters that feed them."""

import numpy as np

from app.config import model_tflite_path
from app.events import EventBus
from app.runtime import RuntimeConfig
from app.service import Analyzer
from app.training import TrainingOrchestrator
from app.warehouse import RedisStore, SqliteStore
from tests.test_service import make_cfg, make_payload  # noqa: PLC2701
from tests.test_ml_layer import make_store, seed  # noqa: PLC2701


def make_analyzer(tmp_path):
    cfg = make_cfg(tmp_path)
    store = SqliteStore(cfg.db_file)
    redis = RedisStore(None, enabled=False)
    events = EventBus()
    runtime = RuntimeConfig(cfg, store)
    analyzer = Analyzer(cfg, store, redis, events=events, runtime=runtime)
    return cfg, store, analyzer


# --- z-scores -------------------------------------------------------------
def test_insert_window_persists_z(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store, n=3)
    raw = store.raw_windows(limit=3)
    assert all(w["z"] is None for w in raw)  # seed() inserts without z

    z = np.asarray([0.1, -0.2, 0.3, 0.4, -0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
    store.insert_window(
        window_start=9_999_000_000_000, feature_vec=np.ones(10),
        context=np.vstack([np.ones(10)]), pcs=np.ones(6),
        loadings=np.ones((10, 6)), eigen=np.ones(6),
        risk="normal", t2=1.0, p_value=0.5, compute_ms=1.0,
        created_at=9_999_000_000_000, z=z,
    )
    raw = store.raw_windows(limit=1)[0]
    assert raw["z"] == [0.1, -0.2, 0.3, 0.4, -0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    cloud = store.pca_cloud(limit=100)
    p = [c for c in cloud if c["windowStart"] == 9_999_000_000_000][0]
    assert p["z"] is not None and len(p["z"]) == 10
    assert p["features"] is not None


def test_ingest_exposes_z_and_feature_names(tmp_path):
    cfg, store, analyzer = make_analyzer(tmp_path)
    base = 2_400_000_000_000
    for i in range(6):
        analyzer.ingest(make_payload(i, base))

    wins = analyzer.raw_windows(limit=10)
    assert wins and len(wins[0]["features"]) == 10
    assert wins[0]["featureNames"] == [
        "log1p_requestsPerMinute", "errorRate", "log1p_p95LatMs", "log1p_p99LatMs",
        "log1p_p95TokPerSec", "log1p_p99TokPerSec", "cpuFrac", "memFrac", "tempC",
        "diskFrac",
    ]
    assert wins[0]["z"] is not None

    reqs = analyzer.raw_requests(limit=10)
    assert reqs and len(reqs[0]["features"]) == 6
    assert reqs[0]["featureNames"] == [
        "log1p_promptTokens", "log1p_completionTokens", "log1p_totalTokens",
        "log1p_tokensPerSecond", "log1p_durationMs", "error",
    ]

    cloud = analyzer.pca_cloud(limit=100)
    names = {tuple(p["featureNames"]) for p in cloud}
    assert names and len(names) == 1  # names stable per cloud snapshot
    assert all(len(p["pcs"]) == 6 for p in cloud)


def test_masked_features_renamed(tmp_path):
    cfg, store, analyzer = make_analyzer(tmp_path)
    analyzer.runtime.save({"featureFilter": [True] * 5 + [False] * 5})
    analyzer._check_reset()  # noqa: SLF001
    base = 2_500_000_000_000
    for i in range(6):
        analyzer.ingest(make_payload(i, base))
    wins = analyzer.raw_windows(limit=5)
    assert wins and len(wins[0]["features"]) == 5
    assert len(wins[0]["featureNames"]) == 5
    assert wins[0]["featureNames"] == [
        "log1p_requestsPerMinute", "errorRate", "log1p_p95LatMs",
        "log1p_p99LatMs", "log1p_p95TokPerSec",
    ]


# --- incremental-training gating -----------------------------------------
def test_should_train_gates_on_watermark(tmp_path):
    cfg, store, analyzer = make_analyzer(tmp_path)
    redis = RedisStore(None, enabled=False)
    events = EventBus()
    trainer = TrainingOrchestrator(cfg, store, redis, events=events, runtime=analyzer.runtime)

    # no model, rows below min -> no
    assert trainer.should_train() is False

    base = 2_600_000_000_000
    for i in range(3):
        analyzer.ingest(make_payload(i, base))
    assert trainer.should_train() is False

    # a model artifact + no watermark set -> yes (first fine-tune since nothing)
    tflite = model_tflite_path(cfg)
    tflite.write_bytes(b"dummy")
    try:
        assert trainer.should_train() is True

        # consume the current history -> no new rows -> no
        latest = store.training_max_window_start()
        trainer.runtime.set_watermark(latest)
        assert trainer.should_train() is False

        # one more scored window after the watermark -> yes
        analyzer.ingest(make_payload(3, base + 1))
        assert store.new_training_rows(latest) == 1
        assert trainer.should_train() is True
    finally:
        tflite.unlink(missing_ok=True)


def test_maybe_start_does_not_run_when_gated(tmp_path):
    cfg, store, analyzer = make_analyzer(tmp_path)
    redis = RedisStore(None, enabled=False)
    trainer = TrainingOrchestrator(cfg, store, redis, events=EventBus(), runtime=analyzer.runtime)
    assert trainer.maybe_start(analyzer) is False
    assert trainer.status()["state"] == "idle"


def test_new_training_rows_counts_only_labeled_after(tmp_path):
    cfg, store = make_store(tmp_path)
    rng = np.random.default_rng(1)
    for i in range(6):
        store.insert_window(
            window_start=3_000_000_000_000 + i * 60_000, feature_vec=rng.normal(size=10),
            context=np.vstack([rng.normal(size=10)]), pcs=rng.normal(size=6),
            loadings=np.ones((10, 6)), eigen=np.ones(6),
            risk="watch" if i % 2 else "normal", t2=1.0, p_value=0.5,
            compute_ms=1.0, created_at=3_000_000_000_000 + i * 60_000,
        )
    before = store.new_training_rows(3_000_000_000_000 + 2 * 60_000)
    assert before == 3  # windows > watermark: 3 rows (of 6)
    after = store.new_training_rows(None)
    assert after == 0  # no watermark -> no incremental rows
    # unlabeled rows do not count
    store.insert_window(window_start=3_000_000_000_000 + 7 * 60_000,
                        feature_vec=np.ones(10), context=np.vstack([np.ones(10)]),
                        pcs=None, loadings=None, eigen=None, risk=None, t2=None,
                        p_value=None, compute_ms=None, created_at=1)
    assert store.new_training_rows(3_000_000_000_000 + 2 * 60_000) == 3