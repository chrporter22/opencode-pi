import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { createLlamaSupervisor } from "../src/modules/llama/supervisor.js";
import { RuntimeState } from "../src/state.js";
import { makeConfig } from "./helpers.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-llama.mjs", import.meta.url));

let portCounter = 21000;
function nextPort(): number {
  return portCounter += 1;
}

const supervisors: Array<{ stop: () => Promise<void> }> = [];

function setup() {
  const port = nextPort();
  const dir = mkdtempSync(join(tmpdir(), "opi-llama-"));
  const pidlog = join(dir, "pids.log");
  const cfg = makeConfig({
    llama: { host: "127.0.0.1", port, bin: STUB, contextSize: 8192, extraArgs: `--stub-pidlog ${pidlog}` },
  });
  const state = new RuntimeState();
  const logger = createLogger({ stdout: false });
  const sup = createLlamaSupervisor({ config: cfg, state, logger });
  supervisors.push(sup);
  return { sup, state, pidlog };
}

function pidLogLines(pidlog: string): string[] {
  if (!existsSync(pidlog)) return [];
  return readFileSync(pidlog, "utf8").trim().split("\n").filter(Boolean);
}

async function waitForReady(state: RuntimeState, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.snapshot().llama === "ready") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for llama to become ready");
}

afterEach(async () => {
  while (supervisors.length) {
    const s = supervisors.pop()!;
    await s.stop().catch(() => {});
  }
});

describe("llama supervisor restart", () => {
  it("restart from ready keeps exactly one process and returns to ready", async () => {
    const { sup, state, pidlog } = setup();
    sup.start();
    await waitForReady(state);
    expect(pidLogLines(pidlog).length).toBe(1);

    await sup.restart();
    await waitForReady(state);
    await new Promise((r) => setTimeout(r, 2500));
    expect(state.snapshot().llama).toBe("ready");
    expect(state.snapshot().modelLoaded).toBe(true);
    expect(pidLogLines(pidlog).length).toBe(2);
  });

  it("restart during the crash backoff window recovers a single process", async () => {
    const { sup, state, pidlog } = setup();
    sup.start();
    await waitForReady(state);
    expect(pidLogLines(pidlog).length).toBe(1);

    process.kill(Number(pidLogLines(pidlog)[0]), "SIGKILL");
    await new Promise((r) => setTimeout(r, 50));
    await sup.restart();
    await waitForReady(state);
    await new Promise((r) => setTimeout(r, 2500));
    expect(state.snapshot().llama).toBe("ready");
    expect(pidLogLines(pidlog).length).toBe(2);
  });

  it("concurrent restarts are single-flight and spawn no duplicate processes", async () => {
    const { sup, state, pidlog } = setup();
    sup.start();
    await waitForReady(state);
    expect(pidLogLines(pidlog).length).toBe(1);

    await Promise.all([sup.restart(), sup.restart(), sup.restart()]);
    await waitForReady(state);
    await new Promise((r) => setTimeout(r, 2500));
    expect(state.snapshot().llama).toBe("ready");
    expect(pidLogLines(pidlog).length).toBe(2);
  });

  it("stop cancels a pending crash respawn", async () => {
    const { sup, state, pidlog } = setup();
    sup.start();
    await waitForReady(state);

    process.kill(Number(pidLogLines(pidlog)[0]), "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    await sup.stop();
    await new Promise((r) => setTimeout(r, 2500));
    expect(state.snapshot().llama).toBe("stopped");
    expect(pidLogLines(pidlog).length).toBe(1);
  });

  it("a crashed process is still respawned with backoff and returns to ready", async () => {
    const { sup, state, pidlog } = setup();
    sup.start();
    await waitForReady(state);
    expect(pidLogLines(pidlog).length).toBe(1);

    process.kill(Number(pidLogLines(pidlog)[0]), "SIGKILL");
    await waitForReady(state, 15000);
    expect(state.snapshot().llama).toBe("ready");
    expect(pidLogLines(pidlog).length).toBe(2);
  }, 20000);
});