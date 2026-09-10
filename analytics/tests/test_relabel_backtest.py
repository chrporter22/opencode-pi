"""Relabel-by-Hotelling-T²-p and hold-out backtest store contracts.

Covers the p-value label tiers, the SQLite relabel upsert (z/loadings kept),
the empty-tflite guard that previously caused /api/analytics/infer to 500,
the backtest_runs/backtest_samples persistence roundtrip, and the
clear-watermark path that returns the orchestrator to full-retrain gating.
"""

import numpy as np

from app.events import EventBus
from app.mathlib import hotelling, label_from_p, risk_label
from app.nn import TFLiteClassifier
from app.config import model_tflite_path
from app.runtime import RuntimeConfig
from app.training import TrainingOrchestrator
from app.warehouse import RedisStore, SqliteStore
from tests.test_service import make_cfg  # noqa: PLC2701
from tests.test_ml_layer import make_store, seed  # noqa: PLC2701
from tests.test_ui_overhaul import make_analyzer, make_payload  # noqa: PLC2701


# --- context windows as a pipeline metric ------------------------------------
def test_risk_carries_context_window_counts(tmp_path):
    cfg, store, analyzer = make_analyzer(tmp_path)
    assert cfg.context_windows == 12
    base = 4_200_000_000_000
    for i in range(6):
        analyzer.ingest(make_payload(i, base))

    risk = analyzer.risk()
    assert risk["contextWindows"] == 6
    assert risk["contextCap"] == 12
    assert risk["windowsScored"] >= 6
    assert risk["level"] in {"normal", "watch", "high"}

    meta = analyzer.meta()
    assert meta["context"] == {"count": 6, "cap": 12}

    # fallback payloads (no score yet) still carry the counts
    analyzer.latest_score = None
    empty = analyzer.risk()
    assert empty["contextWindows"] == 6 and empty["contextCap"] == 12


# --- label tiers -------------------------------------------------------------
def test_label_from_p_tiers():
    assert label_from_p(0.51) == "normal"
    assert label_from_p(0.103) == "normal"
    assert label_from_p(0.10) == "normal"      # boundary: >= p_watch
    assert label_from_p(0.099) == "watch"
    assert label_from_p(0.06) == "watch"
    assert label_from_p(0.05) == "watch"       # boundary: >= p_high
    assert label_from_p(0.0499) == "high"
    assert label_from_p(0.0) == "high"
    assert label_from_p(None) == "normal"      # no p-value -> benign default
    # custom thresholds
    assert label_from_p(0.2, p_watch=0.3, p_high=0.1) == "watch"
    assert label_from_p(0.05, p_watch=0.3, p_high=0.1) == "high"


def test_hotelling_pc_magnitude_ordering():
    mild = hotelling(np.asarray([0.3, -0.2, 0.1, 0.0, 0.0, 0.0]))
    wild = hotelling(np.asarray([3.0, -2.5, 1.8, -1.2, 0.9, 0.4]))
    assert wild[0] > mild[0]          # larger T²
    assert wild[1] < mild[1]          # smaller p -> higher-risk tier
    assert label_from_p(wild[1]) != "normal"


# --- relabel upsert ----------------------------------------------------------
def _insert_pcs_window(store, ws, pcs, z):
    store.insert_window(
        window_start=ws, feature_vec=np.ones(10), context=np.vstack([np.ones(10)]),
        pcs=pcs, loadings=np.ones((10, 6)), eigen=np.ones(6),
        risk="normal", t2=0.0, p_value=1.0, compute_ms=1.0, created_at=ws, z=z,
    )


def test_relabel_recomputes_labels_keeps_z(tmp_path):
    cfg, store = make_store(tmp_path)
    z = np.asarray([0.1, -0.2, 0.3, 0.4, -0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
    ws0, ws1, ws2 = 1_000, 2_000, 3_000
    _insert_pcs_window(store, ws0, np.asarray([0.4, 0.3, 0.2, 0.1, 0.0, -0.1]), z)
    _insert_pcs_window(store, ws1, np.asarray([0.9, -0.8, 0.7, -0.6, 0.5, -0.4]), z)
    _insert_pcs_window(store, ws2, np.asarray([4.0, -3.5, 3.0, -2.5, 2.0, 1.5]), z)

    result = store.relabel_windows(0.10, 0.05)
    assert result["updated"] == 3
    assert result["normal"] + result["watch"] + result["high"] == 3

    rows = {r["windowStart"]: r for r in store.pca_cloud(limit=10)}
    expected = {
        ws0: label_from_p(hotelling(np.asarray([0.4, 0.3, 0.2, 0.1, 0.0, -0.1]))[1]),
        ws1: label_from_p(hotelling(np.asarray([0.9, -0.8, 0.7, -0.6, 0.5, -0.4]))[1]),
        ws2: label_from_p(hotelling(np.asarray([4.0, -3.5, 3.0, -2.5, 2.0, 1.5]))[1]),
    }
    for ws, lab in expected.items():
        row = rows[ws]
        assert row["risk"] == lab          # relabel applied
        t2, pval = hotelling(np.asarray(row["pcs"]))
        assert round(t2, 4) == row["t2"]
        assert round(pval, 6) == row["pValue"]
        assert row["z"] == list(z)         # display z-scores untouched

    # idempotent second pass
    again = store.relabel_windows(0.10, 0.05)
    assert again["updated"] == 3


# --- PCA z-score relabel mode -------------------------------------------------
def test_relabel_windows_z_score_mode(tmp_path):
    cfg, store = make_store(tmp_path)
    z = np.asarray([0.1, -0.2, 0.3, 0.4, -0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
    _insert_pcs_window(store, 1_000, np.asarray([0.4, 0.3, 0.2, 0.1, 0.0, -0.1]), z)  # normal
    _insert_pcs_window(store, 2_000, np.asarray([1.2, -0.8, 0.7, -0.6, 0.5, -0.4]), z)   # watch (>= 1.0)
    _insert_pcs_window(store, 3_000, np.asarray([4.0, -3.5, 3.0, -2.5, 2.0, 1.5]), z)    # high (>= 1.5)

    result = store.relabel_windows(0.10, 0.05, mode="z_score", z_watch=1.0, z_high=1.5)
    assert result["updated"] == 3
    assert result["mode"] == "z_score"
    assert result["zWatch"] == 1.0 and result["zHigh"] == 1.5
    assert result["normal"] == 1 and result["watch"] == 1 and result["high"] == 1

    rows = {r["windowStart"]: r["risk"] for r in store.pca_cloud(limit=10)}
    assert rows[1_000] == "normal"
    assert rows[2_000] == "watch"
    assert rows[3_000] == "high"

    # the same windows under the p-value mode diverge (hotelling p tiers)
    pv = store.relabel_windows(0.10, 0.05)
    rows_p = {r["windowStart"]: r["risk"] for r in store.pca_cloud(limit=10)}
    assert rows_p[1_000] == label_from_p(hotelling(np.asarray([0.4, 0.3, 0.2, 0.1, 0.0, -0.1]))[1])


def test_risk_label_thresholds():
    assert risk_label(np.asarray([0.9, 0.5, 0.2]), 1.0, 1.5) == "normal"
    assert risk_label(np.asarray([1.2, 0.5, 0.2]), 1.0, 1.5) == "watch"
    assert risk_label(np.asarray([1.6, 0.5, 0.2]), 1.0, 1.5) == "high"
    assert risk_label(np.asarray([8.0]), 1.0, 1.5) == "high"
    assert risk_label(np.asarray([], dtype=float)) == "normal"


def test_label_mode_z_score_drives_live_risk(tmp_path):
    cfg, store, analyzer = make_analyzer(tmp_path)
    analyzer.runtime.save({"labelMode": "z_score", "watchZ": 1.0, "highZ": 1.5})
    assert analyzer.runtime.effective()["labelMode"] == "z_score"

    base = 4_200_000_000_000
    for i in range(6):
        analyzer.ingest(make_payload(i, base))

    risk = analyzer.risk()
    assert risk["level"] in {"normal", "watch", "high"}
    zs = np.asarray([c["z"] for c in risk["pcScores"]])
    assert risk["level"] == risk_label(zs, 1.0, 1.5)

    # label_mode lives in the persisted config doc
    assert analyzer.runtime.label_mode == "z_score"


# --- empty-tflite guard ------------------------------------------------------
def test_empty_tflite_is_no_model(tmp_path):
    cfg = make_cfg(tmp_path)
    path = model_tflite_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")                  # the historical 0-byte artifact
    cls = TFLiteClassifier(cfg)
    cls.reset()
    cls._build()                           # must not mmap the empty file
    assert cls.classify(np.ones(10)) is None
    assert cls._interp is None


# --- backtest store roundtrip ------------------------------------------------
def test_backtest_store_roundtrip(tmp_path):
    cfg, store = make_store(tmp_path)
    seed(store, n=3)

    run_id = store.insert_backtest_run("current", 1_600_000_000_000)
    assert store.backtest_runs(5)[0]["state"] == "running"

    store.insert_backtest_sample(run_id, 100, "normal", "normal", [0.9, 0.05, 0.05], 42)
    store.insert_backtest_sample(run_id, 200, "high", "watch", [0.1, 0.7, 0.2], 42)
    store.insert_backtest_sample(run_id, 300, None, "high", [0.05, 0.1, 0.85], 42)

    store.finish_backtest_run(run_id, "done", model_watermark=42,
                              window_from=100, window_to=300,
                              rows=3, correct=1, accuracy=0.3333, f1=0.5)

    run = store.backtest_runs(1)[0]
    assert run["runId"] == run_id and run["state"] == "done"
    assert run["mode"] == "current" and run["modelWatermark"] == 42
    assert run["windowFrom"] == 100 and run["windowTo"] == 300
    assert run["rows"] == 3 and run["correct"] == 1
    assert abs(run["accuracy"] - 0.3333) < 1e-4

    samples = store.backtest_samples(50)
    assert len(samples) == 3
    assert samples[0] == {
        "windowStart": 100, "actual": "normal", "nnRisk": "normal",
        "nnProb": [0.9, 0.05, 0.05], "modelWatermark": 42, "match": True,
    }
    assert samples[2]["actual"] is None and samples[2]["match"] is False

    assert store.backtest_window_count() == 3    # seed() writes a feature_vec
    assert store.backtest_window_count(since=2_300_000_300_000) == 0
    wins = store.backtest_windows()
    assert len(wins) == 3
    assert wins[0][0] < wins[-1][0]
    assert len(store.backtest_windows(since=2_300_000_060_000)) == 1  # strictly newer


# --- clear watermark -> full-retrain gating ----------------------------------
def test_clear_watermark_unblocks_full_train(tmp_path):
    cfg = make_cfg(tmp_path)
    store = SqliteStore(cfg.db_file)
    redis = RedisStore(None, enabled=False)
    runtime = RuntimeConfig(cfg, store)
    trainer = TrainingOrchestrator(cfg, store, redis, runtime=runtime)
    runtime.save({"train": {"minRows": 1}})

    # model exists (dummy non-empty tflite so status() reports active)
    tmx = model_tflite_path(cfg)
    tmx.parent.mkdir(parents=True, exist_ok=True)
    tmx.write_bytes(b"fake-tflite")

    rack = 5_000_000_000_000
    seed(store, n=3)                       # windows all before the watermark
    for i, w in enumerate(store.raw_windows(limit=3)):
        store.conn.execute(
            "UPDATE windows SET window_start=? WHERE id=?", (rack + i, w["id"]))
    store.conn.commit()
    watermark = rack + 2                   # no rows strictly after it

    runtime.set_watermark(watermark)
    trainer.state["trainedUpTo"] = watermark
    assert trainer.status()["modelActive"] is True
    assert trainer.should_train() is False          # nothing new past watermark

    # the /watermark/clear route path
    runtime.set_watermark(None)
    trainer.state["trainedUpTo"] = None
    trainer._persist()  # noqa: SLF001
    assert trainer.should_train() is True           # full retrain again desired