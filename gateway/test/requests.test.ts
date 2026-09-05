import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RuntimeState } from "../src/state.js";
import { createLogger } from "../src/logger.js";
import { createRequestTracker, countRequestRate } from "../src/requests.js";
import { v1Router } from "../src/routes/v1.js";
import { makeConfig } from "./helpers.js";

let upstream!: Server;
let upstreamUrl = "";
let hangServer!: Server;
let hangUrl = "";

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      let stream = false;
      try {
        stream = !!JSON.parse(body)?.stream;
      } catch {}
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}\n\n');
        res.write("data: [DONE]\n\n");
        setTimeout(() => res.end(), 15);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
          })
        );
      }
    });
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", () => resolve());
  });
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  hangServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("data: {}\n\n");
  });
  await new Promise<void>((resolve) => {
    hangServer.listen(0, "127.0.0.1", () => resolve());
  });
  hangUrl = `http://127.0.0.1:${(hangServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  upstream?.close();
  hangServer?.close();
});

function readyApp() {
  const state = new RuntimeState();
  state.setLlama("ready");
  state.setModelLoaded(true);
  const tracker = createRequestTracker();
  const app = express();
  app.use(
    "/v1",
    v1Router({
      config: makeConfig({ llama: { ...makeConfig().llama, url: upstreamUrl } }),
      state,
      logger: createLogger({ stdout: false }),
      requests: tracker,
    })
  );
  return { app, tracker };
}

async function waitUntil(fn: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("countRequestRate", () => {
  it("counts starts within the rolling window", () => {
    const now = 1_000_000;
    const starts = [now - 59_000, now - 40_000, now - 61_000, now - 5_000];
    expect(countRequestRate(starts, now)).toBe(3);
  });

  it("returns zero when no starts fall in the window", () => {
    const now = 1_000_000;
    expect(countRequestRate([now - 120_000, now - 61_000], now)).toBe(0);
  });
});

describe("request tracking via the v1 proxy", () => {
  it("records completed streaming requests with usage and tok/s", async () => {
    const { app, tracker } = readyApp();
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send({ model: "Qwen3-1.7B", stream: true, messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const rec = tracker.snapshot().find((r) => r.status === "completed");
    expect(rec).toBeDefined();
    expect(rec?.promptTokens).toBe(12);
    expect(rec?.completionTokens).toBe(34);
    expect(rec?.totalTokens).toBe(46);
    expect(rec?.durationMs).not.toBeNull();
    expect(rec?.tokensPerSecond).not.toBeNull();
    expect(rec?.tokensPerSecond).toBeCloseTo(34 / ((rec?.durationMs ?? 1) / 1000), 5);
  });

  it("records completed non-stream requests with usage", async () => {
    const { app, tracker } = readyApp();
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send({ model: "Qwen3-1.7B", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const rec = tracker.snapshot().find((r) => r.status === "completed");
    expect(rec?.promptTokens).toBe(5);
    expect(rec?.completionTokens).toBe(20);
    expect(rec?.totalTokens).toBe(25);
  });

  it("records not-ready inference as an error record", async () => {
    const state = new RuntimeState();
    state.setLlama("starting");
    const tracker = createRequestTracker();
    const app = express();
    app.use(
      "/v1",
      v1Router({
        config: makeConfig({ llama: { ...makeConfig().llama, url: upstreamUrl } }),
        state,
        logger: createLogger({ stdout: false }),
        requests: tracker,
      })
    );

    const res = await request(app).post("/v1/chat/completions").send({});
    expect(res.status).toBe(503);
    const rec = tracker.snapshot().find((r) => r.status === "error");
    expect(rec?.error).toBe("inference not ready");
  });

  it("notifies subscribers through the lifecycle", async () => {
    const { app, tracker } = readyApp();
    const seen: Array<{ id: string; status: string }> = [];
    tracker.subscribe((r) => seen.push({ id: r.id, status: r.status }));

    await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send({ model: "Qwen3-1.7B", stream: true, messages: [{ role: "user", content: "hi" }] });

    const started = seen.find((s) => s.status === "started");
    const completed = seen.find((s) => s.status === "completed");
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect(started?.id).toBe(completed?.id);
  });

  it("merges llama task timings when the response carries no usage", async () => {
    const tracker = createRequestTracker();
    const ctx = { method: "POST", path: "/v1/chat/completions", model: "Qwen3-1.7B" };
    tracker.start(ctx);
    const id = tracker.snapshot()[0].id;
    tracker.applyTaskTiming({ promptTokens: 1, completionTokens: 8, totalTokens: 9 });
    await new Promise((r) => setTimeout(r, 15));
    tracker.complete(id, { promptTokens: null, completionTokens: null, totalTokens: null });

    const rec = tracker.snapshot()[0];
    expect(rec.status).toBe("completed");
    expect(rec.promptTokens).toBe(1);
    expect(rec.completionTokens).toBe(8);
    expect(rec.totalTokens).toBe(9);
    expect(rec.tokensPerSecond).toBeCloseTo(8 / ((rec.durationMs ?? 1) / 1000), 5);
  });

  it("prefers response usage over llama task timings", () => {
    const tracker = createRequestTracker();
    const ctx = { method: "POST", path: "/v1/chat/completions", model: "Qwen3-1.7B" };
    tracker.start(ctx);
    const id = tracker.snapshot()[0].id;
    tracker.applyTaskTiming({ promptTokens: 1, completionTokens: 8, totalTokens: 9 });
    tracker.complete(id, { promptTokens: 5, completionTokens: 20, totalTokens: 25 });

    const rec = tracker.snapshot()[0];
    expect(rec.promptTokens).toBe(5);
    expect(rec.completionTokens).toBe(20);
    expect(rec.totalTokens).toBe(25);
  });

  it("back-fills tokens into a completed record when timing arrives after completion", async () => {
    const tracker = createRequestTracker();
    const ctx = { method: "POST", path: "/v1/chat/completions", model: "Qwen3-1.7B" };
    tracker.start(ctx);
    const id = tracker.snapshot()[0].id;
    await new Promise((r) => setTimeout(r, 15));
    tracker.complete(id, { promptTokens: null, completionTokens: null, totalTokens: null });
    tracker.applyTaskTiming({ promptTokens: 16, completionTokens: 8, totalTokens: 24 });

    const rec = tracker.snapshot()[0];
    expect(rec.status).toBe("completed");
    expect(rec.promptTokens).toBe(16);
    expect(rec.completionTokens).toBe(8);
    expect(rec.totalTokens).toBe(24);
    expect(rec.tokensPerSecond).toBeCloseTo(8 / ((rec.durationMs ?? 1) / 1000), 5);
  });

  it("records a client disconnect as an error record", async () => {
    const state = new RuntimeState();
    state.setLlama("ready");
    state.setModelLoaded(true);
    const tracker = createRequestTracker();
    const app = express();
    app.use(
      "/v1",
      v1Router({
        config: makeConfig({ llama: { ...makeConfig().llama, url: hangUrl } }),
        state,
        logger: createLogger({ stdout: false }),
        requests: tracker,
      })
    );

    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve) => {
        const out = httpRequest(
          {
            port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (incoming: IncomingMessage) => {
            incoming.once("data", () => {
              (out as ClientRequest).destroy();
              resolve();
            });
          }
        );
        out.write(JSON.stringify({ model: "Qwen3-1.7B", stream: true, messages: [{ role: "user", content: "hi" }] }));
        out.end();
      });

      await waitUntil(() => tracker.snapshot().some((r) => r.status === "error"));
      const rec = tracker.snapshot().find((r) => r.status === "error");
      expect(rec?.error).toBeTruthy();
    } finally {
      server.close();
    }
  });
});