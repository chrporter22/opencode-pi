import numpy as np
import pytest

from app.config import Config
from app.events import EventBus
from app.service import Analyzer
from app.warehouse import RedisStore, SqliteStore

P = 10


def make_cfg(tmp_path, redis_url=None):
    return Config(
        port=8081,
        ingest_secret="test-secret",
        gateway_url="http://127.0.0.1:9999",
        redis_url=redis_url,
        db_file=str(tmp_path / "analytics.db"),
        feature_window_sec=60,
        context_windows=12,
        ewma_decay=0.1,
        pca_components=6,
        watch_z=1.0,
        high_z=1.5,
        ml_dir=str(tmp_path / "ml"),
        model_name="risk.net",
        train_min_rows=100000,
        train_epochs=2,
        train_batch=32,
        train_trials=3,
        train_validation=0.2,
        train_seed=7,
        embed_enabled=False,
    )


def sample_features(i: int) -> list[float]:
    rng = np.random.default_rng(i)
    return rng.normal(i * 0.05, 1.0, size=P).tolist()


def make_payload(i: int, base_ts: int):
    return {
        "windowStart": base_ts + i * 60_000,
        "features": sample_features(i),
        "requests": [
            {"startedAt": base_ts + i * 60_000, "features": [6.1, 5.2, 7.3, 1.1, 8.0, 0.0], "error": 0},
        ],
    }


def make_analyzer(tmp_path):
    cfg = make_cfg(tmp_path)
    store = SqliteStore(cfg.db_file)
    redis = RedisStore(None, enabled=False)
    pushes = []
    events = EventBus()
    events.subscribe(lambda rec: pushes.append(rec))
    analyzer = Analyzer(cfg, store, redis, events=events)
    return cfg, store, redis, analyzer, pushes


def test_ingest_populates_warehouse(tmp_path):
    cfg, store, _, analyzer, _ = make_analyzer(tmp_path)
    base = 1_700_000_000_000
    for i in range(5):
        analyzer.ingest(make_payload(i, base))
    assert store.count_windows() == 5
    assert store.count_requests() == 5
    assert store.count_windows() >= 1
    win = store.latest_window()
    assert win["windowStart"] == base + 4 * 60_000


def test_ingest_scores_after_context(tmp_path):
    cfg, store, _, analyzer, pushes = make_analyzer(tmp_path)
    base = 1_700_000_000_000
    for i in range(6):
        analyzer.ingest(make_payload(i, base))
    scored = [p for p in pushes if p.get("level") in {"normal", "watch", "high"}]
    assert scored, "expected at least one scored push"
    assert scored[-1]["components"], "expected PCA components vector"
    assert 0 <= scored[-1]["pValue"] <= 1
    # PcaSummary-shaped export
    summary = analyzer.pca_summary()
    assert summary["risk"] == scored[-1]["level"]
    assert isinstance(summary["projection"], list)
    assert isinstance(summary["variance"], list)
    assert summary["totalVariance"] > 0
    assert isinstance(summary["mean"], list)
    assert isinstance(summary["std"], list)
    assert summary["drift"] > 0
    assert summary["driftClassification"] == summary["risk"]
    assert 0 <= summary["confidence"] <= 1
    pts = analyzer.history()
    assert pts and isinstance(pts[0]["projection"], list)
    assert len(summary["eigenvalues"]) >= 1


def test_reference_rehydrates_across_restart(tmp_path):
    cfg, store, _, analyzer, _ = make_analyzer(tmp_path)
    base = 1_800_000_000_000
    for i in range(4):
        analyzer.ingest(make_payload(i, base))
    assert analyzer.reference.n == 4

    cfg2 = make_cfg(tmp_path)
    store2 = SqliteStore(cfg2.db_file)
    redis2 = RedisStore(None, enabled=False)
    analyzer2 = Analyzer(cfg2, store2, redis2)
    assert analyzer2.reference.n == 4


def test_rebaseline_resets_from_stored_windows(tmp_path):
    cfg, store, _, analyzer, _ = make_analyzer(tmp_path)
    for i in range(5):
        analyzer.ingest(make_payload(i, 1_900_000_000_000))
    res = analyzer.rebaseline()
    assert res["ok"] is True
    assert res["windows"] == 5
    assert analyzer.reference.n == 5


def test_ingest_requires_features(tmp_path):
    cfg, store, _, analyzer, _ = make_analyzer(tmp_path)
    assert analyzer.ingest({"windowStart": 0, "features": []}) is None