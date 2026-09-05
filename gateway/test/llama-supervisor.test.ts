import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { buildLlamaArgs, waitForHealth } from "../src/modules/llama/supervisor.js";
import { makeConfig } from "./helpers.js";

describe("buildLlamaArgs", () => {
  it("builds the minimal positional args and model alias", () => {
    const cfg = makeConfig();
    expect(buildLlamaArgs(cfg, "/models/current.gguf")).toEqual([
      "--model", "/models/current.gguf",
      "--host", "127.0.0.1",
      "--port", "8000",
      "--ctx-size", "8192",
      "--alias", "Qwen3-1.7B",
    ]);
  });

  it("appends optional flags and splits extra args", () => {
    const cfg = makeConfig();
    cfg.llama.threads = 4;
    cfg.llama.batchSize = 512;
    cfg.llama.parallel = 1;
    cfg.llama.extraArgs = "--no-mmap  --mlock";
    const args = buildLlamaArgs(cfg, "/models/current.gguf");
    expect(args).toEqual(expect.arrayContaining(["--threads", "4", "--batch-size", "512", "--parallel", "1"]));
    expect(args.slice(-2)).toEqual(["--no-mmap", "--mlock"]);
  });
});

const servers: Server[] = [];

function startHealthServer(healthy: () => boolean): { url: string; setHealthy: (v: boolean) => void } {
  let ok = healthy();
  const srv = createServer((req, res) => {
    if (req.url === "/health" && ok) {
      res.writeHead(200).end("ok");
    } else {
      res.writeHead(503).end("not ready");
    }
  });
  servers.push(srv);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, setHealthy: (v) => void (ok = v) });
    });
  });
}

afterEach(async () => {
  while (servers.length) await new Promise<void>((r) => servers.pop()?.close(() => r()));
});

describe("waitForHealth", () => {
  it("resolves when the endpoint becomes healthy", async () => {
    const { url, setHealthy } = await startHealthServer(() => false);
    const logger = createLogger({ stdout: false });
    const wait = waitForHealth({ url, intervalMs: 20, logger });
    setTimeout(() => setHealthy(true), 60);
    await expect(wait).resolves.toBeUndefined();
  });

  it("rejects on abort", async () => {
    const { url } = await startHealthServer(() => false);
    const logger = createLogger({ stdout: false });
    const ac = new AbortController();
    const wait = waitForHealth({ url, intervalMs: 20, logger }, ac.signal);
    const p = wait.catch((e: Error) => e.message);
    ac.abort();
    await expect(p).resolves.toBe("health wait aborted");
  });
});