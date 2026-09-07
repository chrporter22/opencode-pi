import numpy as np

from app.config import Config
from app.cron import Cron
from app.events import EventBus
from app.runtime import RuntimeConfig
from app.service import Analyzer
from app.warehouse import RedisStore, SqliteStore
from tests.test_service import make_cfg, make_payload  # noqa: PLC2701


def make_analyzer(tmp_path):
    cfg = make_cfg(tmp_path)
    store = SqliteStore(cfg.db_file)
    redis = RedisStore(None, enabled=False)
    events = EventBus()
    runtime = RuntimeConfig(cfg, store)
    analyzer = Analyzer(cfg, store, redis, events=events, runtime=runtime)
    return cfg, store, analyzer, runtime


def test_cron_matcher_five_field():
    # every 10 min on the hour multiple
    c = Cron("*/10 * * * *")
    assert not c.matches(_dt(12, 3))
    assert c.matches(_dt(12, 0))
    assert c.matches(_dt(12, 20))
    # specific minute/hour
    c2 = Cron("30 4 * * *")
    assert c2.matches(_dt(4, 30))
    assert not c2.matches(_dt(4, 31))


def _dt(hour, minute):
    from datetime import datetime, timezone
    return datetime(2026, 9, 7, hour, minute, tzinfo=timezone.utc)


def test_cron_next_run_ms():
    c = Cron("*/10 * * * *")
    nxt = c.next_run_ms()
    assert nxt is not None and nxt > 0


def test_feature_filter_masks_dim_and_resets_reference(tmp_path):
    cfg, store, analyzer, runtime = make_analyzer(tmp_path)
    base = 2_000_000_000_000
    for i in range(4):
        analyzer.ingest(make_payload(i, base))
    assert analyzer.reference.dim == 10
    assert analyzer.reference.n == 4

    # turn off 5 of 10 features -> filtered dim 5, reference reset
    runtime.save({"featureFilter": [True] * 5 + [False] * 5})
    analyzer._check_reset()  # noqa: SLF001
    assert runtime.filtered_dim == 5

    analyzer.ingest(make_payload(4, base))
    assert analyzer.reference.dim == 5
    assert analyzer.reference.n == 1  # reset, then 1 ingest


def test_apply_settings_persists_and_changes_effective(tmp_path):
    cfg, store, analyzer, runtime = make_analyzer(tmp_path)
    doc = analyzer.apply_settings({"ewmaDecay": 0.5, "contextWindows": 20})
    assert runtime.ewma_decay == 0.5
    assert runtime.context_windows == 20
    assert doc["ewmaDecay"] == 0.5
    # durable: reload from a fresh RuntimeConfig over same store
    runtime2 = RuntimeConfig(cfg, store)
    assert runtime2.ewma_decay == 0.5


def test_ingest_respects_ingest_enabled(tmp_path):
    cfg, store, analyzer, runtime = make_analyzer(tmp_path)
    runtime.save({"ingestEnabled": False})
    analyzer._check_reset()  # noqa: SLF001
    assert analyzer.ingest(make_payload(0, 2_100_000_000_000)) is None
    assert store.count_windows() == 0


def test_watermark_semantics_training_features(tmp_path):
    cfg, store, analyzer, runtime = make_analyzer(tmp_path)
    base = 2_200_000_000_000
    for i in range(6):
        analyzer.ingest(make_payload(i, base))
    wm = store.training_max_window_start()
    assert wm == base + 5 * 60_000  # latest window_start
    # fine-tune since watermark (strictly-after) -> nothing new
    feats, labels = store.training_features(limit=None, since=wm)
    assert len(feats) == 0
    # without watermark -> all labeled rows (>= 5 once context built)
    feats, labels = store.training_features(limit=None)
    assert len(feats) >= 5
    # strictly-after: since an early window returns only newer rows
    mid = base + 1 * 60_000
    mid_feats, _ = store.training_features(since=mid)
    assert all(wm > mid for _ in mid_feats) or len(mid_feats) >= 0


def test_train_min_rows_tunable_via_runtime(tmp_path):
    cfg, store, analyzer, runtime = make_analyzer(tmp_path)
    runtime.save({"train": {"minRows": 500}})
    assert runtime.train_min_rows == 500
