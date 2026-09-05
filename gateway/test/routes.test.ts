import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { parseConfig } from "../src/config.js";
import { createLogger, type Logger } from "../src/logger.js";
import type { Metrics } from "../src/metrics.js";
import { createRequestTracker } from "../src/requests.js";
import { RuntimeState } from "../src/state.js";
import { controlRouter } from "../src/routes/control.js";
import { opsRouter } from "../src/routes/ops.js";

function fixtureConfig() {
  return parseConfig({
    INFERENCE_API_KEY: "inf",
    ADMIN_API_KEY: "admin",
    MODEL_URL: "https://example.com/model.gguf",
  });
}

function fixtures() {
  const config = fixtureConfig();
  const logger: Logger = createLogger({ stdout: false });
  const state = new RuntimeState();
  const metrics: Metrics = {
    snapshot: vi.fn().mockResolvedValue({
      timestamp: 1,
      cpu: 42,
      memory: 61.5,
      temperature: 62,
      disk: { usedPercent: 10, availableBytes: 1024 },
      tokensPerSecond: 0,
    }),
    subscribeSample: () => () => {},
    start: vi.fn(),
    stop: vi.fn(),
  };
  const llama = {
    start: vi.fn(),
    restart: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const requests = createRequestTracker();
  return { config, logger, state, metrics, llama, requests };
}

function buildApp(deps: ReturnType<typeof fixtures>, onRestartRequest = () => {}) {
  const app = express();
  app.use("/api", controlRouter(deps));
  app.use("/api", opsRouter({ logger: deps.logger, onRestartRequest }));
  return app;
}

describe("control routes", () => {
  it("GET /api/status reports gateway, llama, model", async () => {
    const deps = fixtures();
    const app = buildApp(deps);
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      gateway: "starting",
      llama: "not_started",
      model: "Qwen3-1.7B",
      modelLoaded: false,
    });
  });

  it("GET /api/model reports metadata with installed=false when missing", async () => {
    const deps = fixtures();
    const app = buildApp(deps);
    const res = await request(app).get("/api/model");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Qwen3-1.7B",
      file: "current.gguf",
      installed: false,
      quantization: null,
      downloadUrl: "https://example.com/model.gguf",
      contextSize: 8192,
      loadingStatus: "none",
    });
    expect(typeof res.body.llamaArgs).toBe("string");
  });

  it("GET /api/metrics returns the sampled snapshot", async () => {
    const deps = fixtures();
    const app = buildApp(deps);
    const res = await request(app).get("/api/metrics");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cpu: 42, memory: 61.5, temperature: 62, tokensPerSecond: 0 });
  });

  it("GET /api/logs returns recent entries", async () => {
    const deps = fixtures();
    deps.logger.info("hello");
    const app = buildApp(deps);
    const res = await request(app).get("/api/logs");
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.entries[0].msg).toBe("hello");
  });

  it("GET /api/requests returns the request ring", async () => {
    const deps = fixtures();
    deps.requests.start({ id: "abc", method: "POST", path: "/chat/completions", model: "Qwen3-1.7B" });
    deps.requests.complete("abc", { promptTokens: 3, completionTokens: 9, totalTokens: 12 });
    const app = buildApp(deps);
    const res = await request(app).get("/api/requests");
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0]).toMatchObject({
      id: "abc",
      status: "completed",
      promptTokens: 3,
      completionTokens: 9,
      totalTokens: 12,
    });
  });
});

describe("ops routes", () => {
  it("POST /api/model/restart calls llama restart and returns ok", async () => {
    const deps = fixtures();
    const app = buildApp(deps);
    const res = await request(app).post("/api/model/restart");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deps.llama.restart).toHaveBeenCalledTimes(1);
  });

  it("POST /api/model/update fails cleanly when MODEL_URL is unset", async () => {
    const deps = fixtures();
    deps.config.model.url = undefined;
    const app = buildApp(deps);
    const res = await request(app).post("/api/model/update");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("update failed");
    expect(res.body.detail).toContain("MODEL_URL");
  });

  it("POST /api/server/restart returns 202 and triggers the restart callback", async () => {
    const deps = fixtures();
    const onRestartRequest = vi.fn();
    const app = buildApp(deps, onRestartRequest);
    const res = await request(app).post("/api/server/restart");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "restarting" });
    await vi.waitFor(() => expect(onRestartRequest).toHaveBeenCalled());
  });
});