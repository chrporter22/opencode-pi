import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RuntimeState } from "../src/state.js";
import { createLogger } from "../src/logger.js";
import { createRequestTracker } from "../src/requests.js";
import { v1Router } from "../src/routes/v1.js";
import { makeConfig } from "./helpers.js";

let upstream!: Server;
let upstreamUrl = "";
let seenAuth: string | undefined;
let seenPath = "";

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seenAuth = req.headers.authorization;
    seenPath = req.url ?? "";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("data: {\"role\":\"assistant\",\"content\":\"hello\"}\n\n");
    setTimeout(() => res.end(), 10);
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", () => resolve());
  });
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => {
  closeServer(upstream);
});

function closeServer(s: Server): void {
  s?.close();
}

describe("v1 proxy", () => {
  it("rejects when llama is not ready", async () => {
    const state = new RuntimeState();
    state.setLlama("starting");
    const app = express();
    app.use("/v1", v1Router({ config: makeConfig({ llama: { ...makeConfig().llama, url: upstreamUrl } }), state, logger: createLogger({ stdout: false }), requests: createRequestTracker() }));

    const res = await request(app).post("/v1/chat/completions").send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("inference not ready");
  });

  it("streams completions and strips authorization upstream", async () => {
    const state = new RuntimeState();
    state.setLlama("ready");
    seenAuth = "UNSET";
    state.setModelLoaded(true);
    const app = express();
    app.use("/v1", v1Router({ config: makeConfig({ llama: { ...makeConfig().llama, url: upstreamUrl } }), state, logger: createLogger({ stdout: false }), requests: createRequestTracker() }));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer secret-inference-key")
      .set("content-type", "application/json")
      .send({ model: "Qwen3-1.7B", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("data: {");
    expect(seenPath).toBe("/chat/completions");
    expect(seenAuth).toBeUndefined();
  });

  it("records request source and client ip", async () => {
    const state = new RuntimeState();
    state.setLlama("ready");
    state.setModelLoaded(true);
    const requests = createRequestTracker();
    const app = express();
    app.use("/v1", v1Router({ config: makeConfig({ llama: { ...makeConfig().llama, url: upstreamUrl } }), state, logger: createLogger({ stdout: false }), requests }));

    await request(app)
      .post("/v1/chat/completions")
      .set("x-opencode-pi-source", "playground")
      .set("x-forwarded-for", "192.168.1.42")
      .send({ model: "Qwen3-1.7B", messages: [{ role: "user", content: "hi" }] });

    const rec = requests.snapshot()[0];
    expect(rec.status).toBe("completed");
    expect(rec.source).toBe("playground");
    expect(rec.ip).toBe("192.168.1.42");
  });
});