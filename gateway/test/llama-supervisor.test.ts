import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { buildLlamaArgs, createTaskTimingParser, waitForHealth } from "../src/modules/llama/supervisor.js";
import { makeConfig } from "./helpers.js";

describe("buildLlamaArgs", () => {
  it("builds the minimal positional args and model alias", () => {
    const cfg = makeConfig();
    expect(buildLlamaArgs(cfg, "/models/current.gguf")).toEqual([
      "--model", "/models/current.gguf",
      "--host", "127.0.0.1",
      "--port", "8000",
      "--ctx-size", "32768",
      "--alias", "Qwen2.5-Coder-3B-Instruct",
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

describe("createTaskTimingParser", () => {
  it("reads token counts from the per-task print_timing summary lines", () => {
    const emitted: Array<{ promptTokens: number; completionTokens: number; totalTokens: number }> = [];
    const parse = createTaskTimingParser((t) => emitted.push(t));
    parse("7.18.978.098 I slot print_timing: id  2 | task 456 | prompt eval time =     397.86 ms /     1 tokens (  397.86 ms per token,     2.51 tokens per second)");
    expect(emitted).toHaveLength(0);
    parse("7.18.978.138 I slot print_timing: id  2 | task 456 |        eval time =    2669.80 ms /     8 tokens (  333.73 ms per token,     3.00 tokens per second)");
    expect(emitted).toHaveLength(0);
    parse("7.18.978.148 I slot print_timing: id  2 | task 456 |       total time =    3067.66 ms /     9 tokens");
    expect(emitted).toEqual([{ promptTokens: 1, completionTokens: 8, totalTokens: 9 }]);
  });
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