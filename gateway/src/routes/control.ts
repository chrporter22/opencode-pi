import { Router } from "express";
import type { Request, Response } from "express";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { RuntimeState } from "../state.js";
import type { LlamaSupervisor } from "../modules/llama/supervisor.js";
import type { RequestTracker } from "../requests.js";
import { readMetadata } from "../model/model-store.js";
import { readHostInfo } from "../hostinfo.js";
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
      requestsPerMinute: deps.requests.requestsPerMinute(),
    });
  });

  router.get("/system/host", (_req, res) => {
    res.json(readHostInfo());
  });

  router.get("/metrics", async (_req, res) => {
    const s = await deps.metrics.snapshot();
    res.json({
      timestamp: s.timestamp,
      cpu: s.cpu,
      memory: s.memory,
      temperature: s.temperature,
      tokensPerSecond: s.tokensPerSecond,
      requestsPerMinute: deps.requests.requestsPerMinute(),
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

  router.get("/analytics/risk", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/risk");
  });
  router.get("/analytics/pca", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/pca");
  });
  router.get("/analytics/historic/windows", async (req, res) => {
    await proxyToAnalytics(
      deps,
      res,
      `/v1/analytics/historic/windows${req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : ""}`
    );
  });
  router.get("/analytics/reference", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/reference");
  });
  router.get("/analytics/config", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/config");
  });
  router.get("/analytics/warehouse/sql", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/warehouse/sql");
  });
  router.get("/analytics/warehouse/redis", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/warehouse/redis");
  });
  router.post("/analytics/warehouse/query", async (req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/warehouse/query", "POST", req.body);
  });
  router.get("/analytics/warehouse/raw/windows", async (req, res) => {
    await proxyToAnalytics(deps, res, `/v1/analytics/warehouse/raw/windows${req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : ""}`);
  });
  router.get("/analytics/warehouse/raw/requests", async (req, res) => {
    await proxyToAnalytics(deps, res, `/v1/analytics/warehouse/raw/requests${req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : ""}`);
  });
  router.get("/analytics/training/status", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/training/status");
  });
  router.post("/analytics/training/start", async (req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/training/start", "POST", req.body ?? undefined);
  });
  router.post("/analytics/relabel", async (req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/relabel", "POST", req.body ?? undefined);
  });
  router.post("/analytics/watermark/clear", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/watermark/clear", "POST");
  });
  router.post("/analytics/backtest", async (req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/backtest", "POST", req.body ?? undefined);
  });
  router.get("/analytics/backtest/status", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/backtest/status");
  });
  router.get("/analytics/backtest/runs", async (req, res) => {
    await proxyToAnalytics(
      deps,
      res,
      `/v1/analytics/backtest/runs${req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : ""}`
    );
  });
  router.get("/analytics/backtest/samples", async (req, res) => {
    await proxyToAnalytics(
      deps,
      res,
      `/v1/analytics/backtest/samples${req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : ""}${req.query.run_id ? `&run_id=${encodeURIComponent(String(req.query.run_id))}` : ""}`
    );
  });
  router.post("/analytics/rebaseline", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/rebaseline", "POST");
  });
  router.get("/analytics/meta", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/meta");
  });
  router.post("/analytics/infer", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/infer", "POST");
  });
  router.put("/analytics/config", async (req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/config", "PUT", req.body);
  });
  router.get("/analytics/pca/cloud", async (req, res) => {
    await proxyToAnalytics(
      deps,
      res,
      `/v1/analytics/pca/cloud${req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : ""}`
    );
  });
  router.get("/analytics/latency/history", async (req, res) => {
    await proxyToAnalytics(
      deps,
      res,
      `/v1/analytics/latency/history${req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : ""}`
    );
  });
  router.get("/analytics/models", async (_req, res) => {
    await proxyToAnalytics(deps, res, "/v1/analytics/models");
  });
  router.get("/analytics/models/:id", async (_req, res) => {
    await proxyToAnalytics(deps, res, `/v1/analytics/models/${encodeURIComponent(_req.params.id)}`);
  });
  router.put("/analytics/models/:id", async (req, res) => {
    await proxyToAnalytics(deps, res, `/v1/analytics/models/${encodeURIComponent(req.params.id)}`, "PUT", req.body);
  });
  router.delete("/analytics/models/:id", async (req, res) => {
    await proxyToAnalytics(deps, res, `/v1/analytics/models/${encodeURIComponent(req.params.id)}`, "DELETE");
  });
  router.get("/analytics/training/runs", async (req, res) => {
    await proxyToAnalytics(
      deps,
      res,
      `/v1/analytics/training/runs${req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : ""}`
    );
  });

  router.get("/analytics/stream", async (_req, res) => {
    await proxyAnalyticsStream(deps, res);
  });

  return router;
}

function analyticsBase(deps: ControlDeps): string | undefined {
  return deps.config.analytics.url && deps.config.analytics.ingestSecret
    ? deps.config.analytics.url
    : undefined;
}

async function proxyToAnalytics(
  deps: ControlDeps,
  res: Response,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown
): Promise<void> {
  const base = analyticsBase(deps);
  if (!base) {
    res.status(503).json({ error: "analytics not configured" });
    return;
  }
  try {
    const headers: Record<string, string> = {
      "x-ingest-secret": deps.config.analytics.ingestSecret || "",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const upstream = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const json = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(json);
  } catch (err) {
    deps.logger.warn(`analytics proxy ${path} failed: ${(err as Error).message}`);
    res.status(502).json({ error: "analytics unreachable", detail: (err as Error).message });
  }
}

async function proxyAnalyticsStream(deps: ControlDeps, res: Response): Promise<void> {
  const base = analyticsBase(deps);
  if (!base) {
    res.status(503).json({ error: "analytics not configured" });
    return;
  }
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(`${base}/v1/analytics/stream`, {
      headers: { "x-ingest-secret": deps.config.analytics.ingestSecret || "" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    deps.logger.warn(`analytics stream connect failed: ${(err as Error).message}`);
    res.status(502).json({ error: "analytics unreachable", detail: (err as Error).message });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status).json({ error: "analytics stream failed" });
    return;
  }
  res.status(200);
  res.set("content-type", "text/event-stream");
  res.set("cache-control", "no-cache");
  res.set("x-accel-buffering", "no");
  res.set("connection", "keep-alive");
  res.flushHeaders();
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // client disconnected / upstream closed
  } finally {
    reader.releaseLock();
    res.end();
  }
}