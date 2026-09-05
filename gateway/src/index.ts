import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { loadConfig } from "./config.js";
import { createAuth, requireAuth } from "./auth.js";
import { createLogger, logger } from "./logger.js";
import { RuntimeState } from "./state.js";
import { createMetrics } from "./metrics.js";
import { startWsServer } from "./ws.js";
import { healthRouter } from "./routes/health.js";
import { controlRouter } from "./routes/control.js";
import { opsRouter } from "./routes/ops.js";
import { v1Router } from "./routes/v1.js";
import { ensureModelAction } from "./model/actions/ensure-model.action.js";
import { createLlamaSupervisor } from "./modules/llama/supervisor.js";

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

const app = express();
app.disable("x-powered-by");

app.use(healthRouter());

app.use(
  "/api",
  requireAuth(auth, "admin"),
  express.json({ limit: "1mb" }),
  controlRouter({ config, state, metrics, logger: log, llama: llamaSupervisor }),
  opsRouter({
    logger: log,
    onRestartRequest: () => shutdown("restart-request"),
  })
);

app.use("/v1", requireAuth(auth, "inference"), v1Router({ config, state, logger: log }));

app.use(express.static(path.resolve("public")));

const httpServer = createServer(app);
const wsServer = startWsServer({ httpServer, auth, state, metrics, logger: log });

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
  void bootstrapModel().then(() => llamaSupervisor.start());
});