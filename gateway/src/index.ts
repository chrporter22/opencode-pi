import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import express from "express";
import { loadConfig } from "./config.js";
import { createAuth, requireAuth } from "./auth.js";
import { createLogger, logger } from "./logger.js";
import { RuntimeState } from "./state.js";
import { createMetrics } from "./metrics.js";
import { createRequestTracker } from "./requests.js";
import { startWsServer } from "./ws.js";
import { healthRouter } from "./routes/health.js";
import { controlRouter } from "./routes/control.js";
import { opsRouter } from "./routes/ops.js";
import { v1Router } from "./routes/v1.js";
import { ensureModelAction } from "./model/actions/ensure-model.action.js";
import { createLlamaSupervisor } from "./modules/llama/supervisor.js";
import { createAnalyticsLiveScorer, createAnalyticsPusher } from "./modules/analytics/pusher.js";

const config = loadConfig();
const auth = createAuth({ inferenceKey: config.keys.inference, adminKey: config.keys.admin });
const state = new RuntimeState();
const log = createLogger({ minLevel: "info" });
const llamaSupervisor = createLlamaSupervisor({ config, state, logger: log });

const metrics = createMetrics({
  getTokensPerSecond: () => state.snapshot().tokensPerSecond,
  modelsDir: config.model.containerDir,
  intervalMs: 5000,
});

const requests = createRequestTracker();
llamaSupervisor.subscribeTaskTiming((t) => requests.applyTaskTiming(t));

const app = express();
app.disable("x-powered-by");

app.use(healthRouter());

const analyticsPusher = config.analytics.url && config.analytics.ingestSecret
  ? createAnalyticsPusher({
      url: config.analytics.url,
      ingestSecret: config.analytics.ingestSecret,
      windowSec: config.analytics.windowSec,
      requests,
      metrics,
      logger: log,
    })
  : null;

const analyticsLiveScorer = config.analytics.url && config.analytics.ingestSecret
  ? createAnalyticsLiveScorer({
      url: config.analytics.url,
      ingestSecret: config.analytics.ingestSecret,
      windowSec: config.analytics.windowSec,
      requests,
      metrics,
      logger: log,
    })
  : null;

let wsServer!: ReturnType<typeof startWsServer>;

function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb);
}

app.post(
  "/api/analytics/scores",
  (req, res, next) => {
    const header = req.headers["x-ingest-secret"];
    const ok = typeof header === "string" && !!config.analytics.ingestSecret &&
      safeCompare(header, config.analytics.ingestSecret);
    if (!ok) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  },
  express.json({ limit: "1mb" }),
  (req, res) => {
    const payload = req.body as Record<string, unknown> | undefined;
    if (payload && typeof payload === "object" && typeof payload.type === "string" &&
        (payload.type.startsWith("analytics.") ||
         payload.type.startsWith("training.") ||
         payload.type === "pca" ||
         payload.type.startsWith("store."))) {
      wsServer.broadcast(payload);
    }
    res.json({ ok: true });
  }
);

app.use(
  "/api",
  requireAuth(auth, "admin"),
  express.json({ limit: "1mb" }),
  controlRouter({ config, state, metrics, logger: log, llama: llamaSupervisor, requests }),
  opsRouter({
    logger: log,
    onRestartRequest: () => shutdown("restart-request"),
  })
);

app.use("/v1", requireAuth(auth, "inference"), v1Router({ config, state, logger: log, requests }));

app.use(
  express.static(path.resolve("public"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    },
  })
);

const httpServer = createServer(app);
wsServer = startWsServer({ httpServer, auth, state, metrics, logger: log, requests });

let shuttingDown = false;
let bootstrapDone = false;

async function bootstrapModel(): Promise<void> {
  if (bootstrapDone) return;
  bootstrapDone = true;
  try {
    state.setModel("loading");
    await ensureModelAction({
      ctx: {
        dir: config.model.containerDir,
        file: config.model.file,
        url: config.model.url,
        sha256: config.model.sha256,
      },
      events: {
        log: (level, msg) => {
          if (level === "info") log.info(msg);
          else if (level === "warn") log.warn(msg);
          else log.error(msg);
        },
        progress: (p) => {
          if (p.phase === "downloading" && p.percent !== undefined) {
            log.info(`Model download: ${p.percent}%`);
          }
        },
      },
    });
    state.setModel("loaded");
  } catch (err) {
    state.setModel("error");
    log.error(`Model bootstrap failed: ${(err as Error).message}`);
  }
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Shutting down (${signal})`);
  state.setGateway("stopping");
  metrics.stop();
  analyticsPusher?.stop();
  analyticsLiveScorer?.stop();
  wsServer.close();
  void llamaSupervisor.stop();
  httpServer.close(() => {
    log.info("Gateway stopped");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log.info(`Gateway listening on ${config.gateway.host}:${config.gateway.port}`);
httpServer.listen(config.gateway.port, config.gateway.host, () => {
  state.setGateway("online");
  log.info("Gateway ready");
  metrics.start();
  analyticsPusher?.start();
  analyticsLiveScorer?.start();
  void bootstrapModel().then(() => llamaSupervisor.start());
});