import { Router } from "express";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { RuntimeState } from "../state.js";
import type { LlamaSupervisor } from "../modules/llama/supervisor.js";
import type { RequestTracker } from "../requests.js";
import { readMetadata } from "../model/model-store.js";
import { updateModelAction } from "../model/actions/update-model.action.js";

export interface ControlDeps {
  config: Config;
  state: RuntimeState;
  metrics: Metrics;
  logger: Logger;
  llama: LlamaSupervisor;
  requests: RequestTracker;
}

async function modelMetadata(deps: ControlDeps) {
  const { config } = deps;
  const meta = await readMetadata(
    {
      dir: config.model.containerDir,
      file: config.model.file,
      url: config.model.url,
      sha256: config.model.sha256,
    },
    config.model.name
  );

  const args = [
    `--model ${config.model.containerPath}`,
    `--host ${config.llama.host}`,
    `--port ${config.llama.port}`,
    `--ctx-size ${config.llama.contextSize}`,
    ...(config.llama.threads !== undefined ? [`--threads ${config.llama.threads}`] : []),
    ...(config.llama.batchSize !== undefined ? [`--batch-size ${config.llama.batchSize}`] : []),
    ...(config.llama.parallel !== undefined ? [`--parallel ${config.llama.parallel}`] : []),
    ...(config.llama.extraArgs ? [config.llama.extraArgs] : []),
  ].join(" ");

  return {
    name: meta.name,
    file: meta.file,
    quantization: meta.quantization ?? config.model.quant ?? null,
    installed: meta.installed,
    sizeBytes: meta.sizeBytes,
    installedAt: meta.installedAt,
    sha256: meta.sha256 ?? null,
    downloadUrl: meta.downloadUrl ?? null,
    contextSize: config.llama.contextSize,
    llamaArgs: args,
    loadingStatus: deps.state.snapshot().model,
  };
}

export function controlRouter(deps: ControlDeps): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    const s = deps.state.snapshot();
    res.json({
      gateway: s.gateway === "online" ? "online" : s.gateway,
      llama: s.llama,
      model: deps.config.model.name,
      modelLoaded: s.modelLoaded,
    });
  });

  router.get("/model", async (_req, res) => {
    res.json(await modelMetadata(deps));
  });

  router.get("/system", async (_req, res) => {
    const s = await deps.metrics.snapshot();
    res.json({
      cpu: s.cpu,
      memory: s.memory,
      temperature: s.temperature,
      disk: s.disk,
      tokensPerSecond: s.tokensPerSecond,
    });
  });

  router.get("/metrics", async (_req, res) => {
    const s = await deps.metrics.snapshot();
    res.json({
      timestamp: s.timestamp,
      cpu: s.cpu,
      memory: s.memory,
      temperature: s.temperature,
      tokensPerSecond: s.tokensPerSecond,
    });
  });

  router.get("/logs", (_req, res) => {
    res.json({ entries: deps.logger.snapshot() });
  });

  router.get("/requests", (_req, res) => {
    res.json({ entries: deps.requests.snapshot() });
  });

  let modelUpdateInFlight = false;

  router.post("/model/restart", async (_req, res) => {
    try {
      deps.state.setModelLoaded(false);
      await deps.llama.restart();
      res.json({ ok: true });
    } catch (err) {
      deps.logger.error(`model restart failed: ${(err as Error).message}`);
      res.status(500).json({ error: "restart failed", detail: (err as Error).message });
    }
  });

  router.post("/model/update", async (_req, res) => {
    if (modelUpdateInFlight) {
      res.status(409).json({ error: "model update already in progress" });
      return;
    }
    modelUpdateInFlight = true;
    try {
      deps.state.setModel("loading");
      await updateModelAction({
        ctx: {
          dir: deps.config.model.containerDir,
          file: deps.config.model.file,
          url: deps.config.model.url,
          sha256: deps.config.model.sha256,
        },
        events: {
          log: (level, msg) => {
            if (level === "info") deps.logger.info(msg);
            else if (level === "warn") deps.logger.warn(msg);
            else deps.logger.error(msg);
          },
          progress: (p) => {
            if (p.phase === "downloading" && p.percent !== undefined) {
              deps.logger.info(`Model download: ${p.percent}%`);
            }
          },
        },
      });
      deps.state.setModel("loaded");
      await deps.llama.restart();
      res.json({ ok: true });
    } catch (err) {
      deps.state.setModel("error");
      deps.logger.error(`model update failed: ${(err as Error).message}`);
      res.status(500).json({ error: "update failed", detail: (err as Error).message });
    } finally {
      modelUpdateInFlight = false;
    }
  });

  return router;
}