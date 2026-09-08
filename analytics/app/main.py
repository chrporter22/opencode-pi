from __future__ import annotations

import hmac
import json
import queue
import threading
import time
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .config import load_config
from .cron import Cron
from .events import EventBus
from .runtime import RuntimeConfig
from .service import Analyzer
from .training import TrainingOrchestrator
from .warehouse import RedisStore, SqliteStore, now_ms

_START = time.time()


def make_push_to_gateway(cfg):
    def push(payload: dict) -> None:
        try:
            body = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{cfg.gateway_url}/api/analytics/scores",
                data=body,
                headers={"content-type": "application/json",
                         "x-ingest-secret": cfg.ingest_secret},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=8):  # noqa: S310
                pass
        except Exception:  # noqa: BLE001
            # gateway unreachable: score is cached in Redis + SQLite
            pass

    return push


def create_app(env: dict | None = None, analyzer: Analyzer | None = None, trainer=None):
    cfg = load_config(env)
    store = SqliteStore(cfg.db_file)
    redis = RedisStore(cfg.redis_url)
    events = EventBus()
    runtime = RuntimeConfig(cfg, store)

    if analyzer is None:
        analyzer = Analyzer(cfg, store, redis, events=events, runtime=runtime)
    if trainer is None:
        trainer = TrainingOrchestrator(cfg, store, redis, events=events, runtime=runtime)

    # Escalate every live event to the gateway WS fan-out (typed events).
    events.subscribe(make_push_to_gateway(cfg))

    def _cron_listen() -> None:
        last_minute = -1
        while True:
            try:
                now_dt = datetime.now(timezone.utc)
                minute = int(now_dt.timestamp() // 60)
                schedule = Cron(runtime.cron)
                if minute != last_minute and schedule.match(now_dt):
                    last_minute = minute
                    trainer.maybe_start(analyzer)
            except Exception:  # noqa: BLE001
                pass
            time.sleep(30)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        threading.Thread(target=_cron_listen, daemon=True).start()
        yield
        store.close()

    app = FastAPI(title="opencode-pi analytics", version="0.1.0", lifespan=lifespan)

    def auth(x_ingest_secret: str | None = Header(default=None)) -> None:
        expected = cfg.ingest_secret
        if not expected or not x_ingest_secret:
            raise HTTPException(status_code=401, detail="unauthorized")
        if not hmac.compare_digest(x_ingest_secret, expected):
            raise HTTPException(status_code=401, detail="unauthorized")

    app.get("/v1/analytics/health")(lambda: {
        "status": "ok",
        "uptimeSeconds": round(time.time() - _START),
        "port": cfg.port,
        "windows": store.count_windows(),
        "requests": store.count_requests(),
        "latestRisk": store.latest_window()["risk"] if store.latest_window() else None,
        "modelActive": trainer.status()["modelActive"],
    })

    def _config_doc() -> dict:
        effective = runtime.effective()
        effective["nextRun"] = Cron(runtime.cron).next_run_ms()
        effective["models"] = store.list_models()
        effective["featureWindowSec"] = cfg.feature_window_sec
        effective["mlDir"] = cfg.ml_dir
        effective["redisAvailable"] = redis.available()
        return effective

    app.get("/v1/analytics/config")(lambda: _config_doc())

    @app.put("/v1/analytics/config", dependencies=[Depends(auth)])
    async def config_put(payload: dict):
        analyzer.apply_settings(payload)
        return _config_doc()

    @app.get("/v1/analytics/meta")
    async def meta():
        return analyzer.meta()

    @app.post("/v1/analytics/infer", dependencies=[Depends(auth)])
    async def infer():
        result = analyzer.infer_now()
        if result is None:
            raise HTTPException(status_code=404,
                                detail="no model or no scored windows to infer")
        return result

    @app.post("/v1/analytics/infer/current", dependencies=[Depends(auth)])
    async def infer_current(payload: dict):
        result = analyzer.live_score(payload.get("features"))
        if result is None:
            raise HTTPException(status_code=404,
                                detail="no model or invalid live feature vector")
        return result

    @app.post("/v1/analytics/ingest", dependencies=[Depends(auth)])
    async def ingest(payload: dict):
        try:
            record = analyzer.ingest(payload)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        if record is not None:
            trainer.maybe_start(analyzer)
        return {"ok": True, "score": record}

    app.get("/v1/analytics/risk")(lambda: analyzer.pca_summary())
    app.get("/v1/analytics/pca")(lambda: analyzer.pca_summary())

    @app.get("/v1/analytics/historic/windows")
    async def historic_windows(limit: int = Query(default=120, ge=1, le=1000)):
        return analyzer.history(limit)

    @app.get("/v1/analytics/pca/cloud")
    async def pca_cloud(limit: int = Query(default=300, ge=1, le=1000)):
        return analyzer.pca_cloud(limit)

    @app.get("/v1/analytics/latency/history")
    async def latency_history(limit: int = Query(default=120, ge=1, le=500)):
        return analyzer.latency_history(limit)

    @app.get("/v1/analytics/models", dependencies=[Depends(auth)])
    async def models_list():
        return store.list_models()

    @app.get("/v1/analytics/models/{model_id}", dependencies=[Depends(auth)])
    async def model_get(model_id: int):
        row = store.get_model(model_id)
        if row is None:
            raise HTTPException(status_code=404, detail="model not found")
        return row

    @app.put("/v1/analytics/models/{model_id}", dependencies=[Depends(auth)])
    async def model_put(model_id: int, payload: dict):
        row = store.set_model(
            model_id,
            enabled=payload.get("enabled"),
            filter_=payload.get("filter"),
            sampling=payload.get("sampling"),
        )
        if not row:
            raise HTTPException(status_code=404, detail="model not found")
        analyzer.nn.reset()
        return store.get_model(model_id)

    @app.delete("/v1/analytics/models/{model_id}", dependencies=[Depends(auth)])
    async def model_delete(model_id: int):
        if not store.delete_model(model_id):
            raise HTTPException(status_code=404, detail="model not found")
        return {"ok": True}

    app.get("/v1/analytics/reference")(lambda: analyzer.reference_snapshot())

    @app.post("/v1/analytics/rebaseline", dependencies=[Depends(auth)])
    async def rebaseline():
        return analyzer.rebaseline()

    app.get("/v1/analytics/warehouse/sql")(lambda: store.sql_status())

    @app.post("/v1/analytics/warehouse/query", dependencies=[Depends(auth)])
    async def warehouse_query(payload: dict):
        try:
            return store.query(str(payload.get("sql", "")))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"query failed: {exc}") from exc

    @app.get("/v1/analytics/warehouse/raw/windows", dependencies=[Depends(auth)])
    async def warehouse_raw_windows(limit: int = Query(default=25, ge=1, le=200)):
        return analyzer.raw_windows(limit)

    @app.get("/v1/analytics/warehouse/raw/requests", dependencies=[Depends(auth)])
    async def warehouse_raw_requests(limit: int = Query(default=25, ge=1, le=200)):
        return analyzer.raw_requests(limit)

    @app.get("/v1/analytics/warehouse/redis")
    async def warehouse_redis():
        return redis.status()

    @app.get("/v1/analytics/training/status")
    async def training_status():
        return trainer.status()

    @app.post("/v1/analytics/training/start", dependencies=[Depends(auth)])
    async def training_start(payload: dict | None = None):
        mode = (payload or {}).get("mode", "auto")
        started = trainer.start(analyzer, mode=mode)
        return {"ok": started, "mode": mode, "status": trainer.status()}

    @app.get("/v1/analytics/training/runs")
    async def training_runs(limit: int = Query(default=20, ge=1, le=100)):
        return store.training_runs(limit)

    @app.get("/v1/analytics/stream")
    async def stream(request: Request, x_ingest_secret: str | None = Header(default=None)):
        if not cfg.ingest_secret or not x_ingest_secret or \
                not hmac.compare_digest(x_ingest_secret, cfg.ingest_secret):
            raise HTTPException(status_code=401, detail="unauthorized")

        def sse_stream():
            q: queue.SimpleQueue = queue.SimpleQueue()

            def enqueue(payload: dict) -> None:
                q.put(payload)

            unsub = events.subscribe(enqueue)
            try:
                seed = {
                    "type": "analytics.risk",
                }
                latest = analyzer.risk()
                seed.update(latest if isinstance(latest, dict) else {})
                seed["training"] = trainer.status()
                yield f"event: analytics.seed\ndata: {json.dumps(seed)}\n\n"
                while True:
                    try:
                        payload = q.get(timeout=15)
                    except queue.Empty:
                        yield ": keepalive\n\n"
                        continue
                    yield f"event: {payload.get('type', 'event')}\ndata: {json.dumps(payload)}\n\n"
            finally:
                unsub()

        return StreamingResponse(
            sse_stream(),
            media_type="text/event-stream",
            headers={"cache-control": "no-cache", "x-accel-buffering": "no",
                     "connection": "keep-alive"},
        )

    @app.post("/v1/analytics/self/push-test", dependencies=[Depends(auth)])
    async def self_push_test():
        """Manual trigger: emit an analytics.risk style event through the bus."""
        events.emit({"type": "analytics.ping", "timestamp": now_ms(), "ok": True})
        return {"ok": True}

    return app


app = create_app()