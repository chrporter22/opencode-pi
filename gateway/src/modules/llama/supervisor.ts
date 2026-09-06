import { spawn, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";
import type { RuntimeState } from "../../state.js";

export const MAX_CONSECUTIVE_FAILURES = 5;
export const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000] as const;
export const HEALTH_POLL_MS = 1000;
export const HEALTH_PATH = "/health";

export function healthUrl(base: string): string {
  return `${base.replace(/\/$/, "")}${HEALTH_PATH}`;
}

export function buildLlamaArgs(config: Config, modelPath: string): string[] {
  const l = config.llama;
  const args = [
    "--model",
    modelPath,
    "--host",
    l.host,
    "--port",
    String(l.port),
    "--ctx-size",
    String(l.contextSize),
  ];
  if (config.model.name) args.push("--alias", config.model.name);
  if (l.threads !== undefined) args.push("--threads", String(l.threads));
  if (l.batchSize !== undefined) args.push("--batch-size", String(l.batchSize));
  if (l.parallel !== undefined) args.push("--parallel", String(l.parallel));
  if (l.extraArgs) args.push(...l.extraArgs.split(/\s+/).filter(Boolean));
  return args;
}

export interface HealthWaitOptions {
  url: string;
  intervalMs?: number;
  logger: Logger;
}

export function waitForHealth(opts: HealthWaitOptions, signal?: AbortSignal): Promise<void> {
  const intervalMs = opts.intervalMs ?? HEALTH_POLL_MS;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("health wait aborted"));
    };
    if (signal?.aborted) {
      reject(new Error("health wait aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (signal?.aborted) return;
      try {
        const res = await fetch(healthUrl(opts.url), { signal: AbortSignal.timeout(intervalMs) });
        if (res.ok) {
          signal?.removeEventListener("abort", onAbort);
          resolve();
          return;
        }
      } catch {
        opts.logger.debug(`llama health check not ready: ${opts.url}`);
      }
      timer = setTimeout(poll, intervalMs);
    };
    timer = setTimeout(poll, 0);
  });
}

export interface LlamaSupervisorOptions {
  config: Config;
  state: RuntimeState;
  logger: Logger;
}

export interface LlamaTaskTiming {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function createTaskTimingParser(onComplete: (t: LlamaTaskTiming) => void): (line: string) => void {
  const tasks = new Map<number, Partial<LlamaTaskTiming>>();
  return (line) => {
    const taskMatch = /task\s+(\d+)/.exec(line);
    if (!taskMatch) return;
    const id = Number(taskMatch[1]);
    let acc = tasks.get(id);
    if (!acc) {
      acc = {};
      tasks.set(id, acc);
    }
    const prompt = /prompt eval time =\s+[\d.]+ ms \/\s+(\d+) tokens/.exec(line);
    const evalTime = /(?<!prompt )eval time =\s+[\d.]+ ms \/\s+(\d+) tokens/.exec(line);
    const total = /total time =\s+[\d.]+ ms \/\s+(\d+) tokens/.exec(line);
    if (prompt) acc.promptTokens = Number(prompt[1]);
    if (evalTime) acc.completionTokens = Number(evalTime[1]);
    if (total && acc.completionTokens != null) {
      tasks.delete(id);
      onComplete({
        promptTokens: acc.promptTokens ?? 0,
        completionTokens: acc.completionTokens,
        totalTokens: total ? Number(total[1]) : acc.completionTokens,
      });
    }
  };
}

export interface LlamaSupervisor {
  start(): void;
  restart(): Promise<void>;
  stop(): Promise<void>;
  subscribeTaskTiming(cb: (t: LlamaTaskTiming) => void): () => void;
}

export function createLlamaSupervisor(opts: LlamaSupervisorOptions): LlamaSupervisor {
  const { config, state, logger } = opts;
  let child: ChildProcess | null = null;
  let stopping = false;
  let consecutiveFailures = 0;
  let restartInFlight = false;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;
  const intentionallyStopped = new Set<ChildProcess>();

  const timingSubscribers = new Set<(t: LlamaTaskTiming) => void>();
  function emitTiming(t: LlamaTaskTiming): void {
    for (const cb of timingSubscribers) cb(t);
  }

  function clearRespawn(): void {
    if (respawnTimer !== null) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
  }

  function scheduleRespawn(delay: number): void {
    clearRespawn();
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      spawnLlama();
    }, delay);
  }

  function terminate(prev: ChildProcess): Promise<void> {
    intentionallyStopped.add(prev);
    return new Promise((resolve) => {
      prev.once("exit", () => resolve());
      prev.kill("SIGTERM");
      setTimeout(() => {
        if (prev.exitCode === null && prev.signalCode === null) prev.kill("SIGKILL");
      }, 3000).unref();
    });
  }

  function spawnLlama(): void {
    const bin = config.llama.bin;
    try {
      accessSync(bin);
    } catch {
      logger.error(`llama-server not found at ${bin}; run ./scripts/install.sh`);
      state.setLlama("error");
      return;
    }
    const args = buildLlamaArgs(config, config.model.containerPath);
    logger.info(`Spawning ${bin} ${args.join(" ")}`);
    state.setLlama("starting");
    state.setModelLoaded(false);

    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    const parseTiming = createTaskTimingParser(emitTiming);

    proc.stdout?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) logger.info(`[llama] ${line.trim()}`);
      }
    });
    proc.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        parseTiming(trimmed);
        const tps = /(\d+(?:\.\d+)?)\s+tokens\s+per\s+second/i.exec(trimmed);
        if (tps) state.setTokensPerSecond(Number(tps[1]));
        logger.warn(`[llama] ${trimmed}`);
      }
    });

    const onExit = async () => {
      if (child === proc) child = null;
      if (intentionallyStopped.delete(proc)) return;
      state.setModelLoaded(false);
      if (stopping) {
        state.setLlama("stopped");
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        logger.error("llama-server keeps failing; giving up until restart requested");
        state.setLlama("error");
        return;
      }
      const delay = BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
      logger.warn(`llama-server exited; restarting in ${delay}ms (attempt ${consecutiveFailures})`);
      state.setLlama("restarting");
      scheduleRespawn(delay);
    };

    proc.on("exit", onExit);
    void waitForHealth({ url: config.llama.url, logger }).then(() => {
      if (child === proc) {
        consecutiveFailures = 0;
        state.setLlama("ready");
        state.setModelLoaded(true);
        logger.info("llama-server is ready");
      }
    });
  }

  return {
    start() {
      clearRespawn();
      stopping = false;
      spawnLlama();
    },
    async restart() {
      if (restartInFlight) return;
      restartInFlight = true;
      try {
        clearRespawn();
        stopping = false;
        consecutiveFailures = 0;
        const prev = child;
        if (prev) {
          state.setLlama("restarting");
          await terminate(prev);
        }
        spawnLlama();
      } finally {
        restartInFlight = false;
      }
    },
    async stop() {
      stopping = true;
      clearRespawn();
      const prev = child;
      if (prev) await terminate(prev);
      state.setLlama("stopped");
    },
    subscribeTaskTiming(cb) {
      timingSubscribers.add(cb);
      return () => {
        timingSubscribers.delete(cb);
      };
    },
  };
}