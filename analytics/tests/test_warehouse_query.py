import pytest

from app.warehouse import RedisStore, SqliteStore
from tests.test_service import make_cfg, make_payload  # noqa: PLC2701


def make_store(tmp_path):
    cfg = make_cfg(tmp_path)
    return cfg, SqliteStore(cfg.db_file)


def seed(store):
    # mirrors Analyzer.ingest persistence path
    import numpy as np
    base = 2_300_000_000_000
    for i in range(5):
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
            p_value=0.5 - i * 0.05,
            compute_ms=0.5 + i,
            created_at=base + i * 60_000,
            nn_latency_ms=1.0 + i * 0.1,
            nn_risk="normal" if i % 2 == 0 else "watch",
            nn_prob=[0.6, 0.3, 0.1] if i % 2 == 0 else [0.2, 0.6, 0.2],
        )
        store.insert_request(
            started_at=base + i * 60_000,
            error=1 if i == 3 else 0,
            feature_vec=np.asarray([6.1, 5.2, 7.3, 1.1, 8.0, 0.0]),
        )


def test_query_select_reads_rows(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store)
    res = store.query("SELECT id, window_start, risk FROM windows ORDER BY id LIMIT 3")
    assert res["error"] is None
    assert res["columns"] == ["id", "window_start", "risk"]
    assert len(res["rows"]) == 3
    assert res["rows"][0][2] in {"normal", "watch"}


def test_query_decodes_numeric_blobs(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store)
    res = store.query("SELECT feature_vec FROM windows LIMIT 1")
    assert len(res["rows"]) == 1
    cell = res["rows"][0][0]
    assert cell.startswith("[") and cell.endswith("]")
    assert len(cell.split(",")) >= 2


def test_query_rejects_writes(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store)
    with pytest.raises((ValueError, Exception)):
        store.query("DELETE FROM windows")
    with pytest.raises(ValueError):
        store.query("INSERT INTO windows(window_start, created_at) VALUES (1, 1)")
    count = store.count_windows()
    assert count == 5  # nothing was touched


def test_query_truncates_rows(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store)
    res = store.query("SELECT id FROM windows", limit=3)
    assert len(res["rows"]) == 3
    assert res["truncated"] is True


def test_raw_windows_and_requests(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store)
    wins = store.raw_windows(limit=10)
    assert len(wins) == 5
    assert wins[0]["features"] is not None and len(wins[0]["features"]) == 10
    assert wins[0]["risk"] in {"normal", "watch"}
    assert wins[0]["t2"] is not None
    reqs = store.raw_requests(limit=10)
    assert len(reqs) == 5
    assert len(reqs[0]["features"]) == 6
    assert any(r["error"] for r in reqs)