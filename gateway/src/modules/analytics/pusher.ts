import type { Logger } from "../../logger.js";
import type { Metrics } from "../../metrics.js";
import type { RequestRecord, RequestTracker } from "../../requests.js";

export interface AnalyticsPusherDeps {
  url: string;
  ingestSecret: string;
  windowSec: number;
  requests: RequestTracker;
  metrics: Metrics;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export interface AnalyticsPusher {
  start(): void;
  stop(): void;
  pushNow(): Promise<void>;
}

const FEATURE_NAMES = [
  "log1p_requestsPerMinute",
  "errorRate",
  "log1p_p95LatMs",
  "log1p_p99LatMs",
  "log1p_p95TokPerSec",
  "log1p_p99TokPerSec",
  "cpuFrac",
  "memFrac",
  "tempC",
  "diskFrac",
];

const MAX_BACKLOG_WINDOWS = 48;

function pct(vals: number[], p: number): number {
  if (vals.length === 0) return 0;
  const arr = [...vals].sort((a, b) => a - b);
  const idx = (arr.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? arr[lo] : arr[lo] * (hi - idx) + arr[hi] * (idx - lo);
}

function log1p(n: number | null | undefined): number {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return 0;
  return Math.log1p(n);
}

interface SysOrFallback {
  cpu: number | null;
  memory: number | null;
  temperature: number | null;
  disk: { usedPercent: number | null };
}

async function awaitMetrics(metrics: Metrics): Promise<SysOrFallback> {
  try {
    return await metrics.snapshot();
  } catch {
    return { cpu: null, memory: null, temperature: null, disk: { usedPercent: null } };
  }
}

function collectRecords(requests: RequestTracker, from: number): RequestRecord[] {
  return requests.snapshot().filter(
    (r: RequestRecord) =>
      (r.status === "completed" || r.status === "error") && r.startedAt >= from
  );
}

function composeFeatures(requests: RequestTracker, records: RequestRecord[], sys: SysOrFallback): number[] {
  const latencies = records
    .map((r) => r.durationMs)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const rates = records
    .map((r) => r.tokensPerSecond)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const errors = records.filter((r) => r.status === "error").length;
  const errorRate = records.length > 0 ? errors / records.length : 0;

  return [
    log1p(requests.requestsPerMinute()),
    errorRate,
    log1p(pct(latencies, 95)),
    log1p(pct(latencies, 99)),
    log1p(pct(rates, 95)),
    log1p(pct(rates, 99)),
    sys.cpu != null ? sys.cpu / 100 : 0,
    sys.memory != null ? sys.memory / 100 : 0,
    sys.temperature ?? 0,
    sys.disk.usedPercent != null ? sys.disk.usedPercent / 100 : 0,
  ];
}

export function createAnalyticsPusher(deps: AnalyticsPusherDeps): AnalyticsPusher {
  let timer: NodeJS.Timeout | undefined;
  const backlog: unknown[] = [];

  async function windowPayload(): Promise<unknown> {
    const now = Date.now();
    const tile = deps.windowSec * 1000;
    // Anchored to wall-clock tiles so windows are created on the :00/:60 marks.
    const from = Math.floor(now / tile) * tile;

    const records = collectRecords(deps.requests, from);
    const sys = await awaitMetrics(deps.metrics);
    return {
      windowStart: from,
      windowEnd: now,
      features: composeFeatures(deps.requests, records, sys),
      requests: records.map((r) => ({
        startedAt: r.startedAt,
        features: [
          log1p(r.promptTokens),
          log1p(r.completionTokens),
          log1p(r.totalTokens),
          log1p(r.tokensPerSecond),
          log1p(r.durationMs),
          r.status === "error" ? 1 : 0,
        ],
        error: r.status === "error" ? 1 : 0,
      })),
    };
  }

  async function post(payload: unknown): Promise<boolean> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${deps.url}/v1/analytics/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": deps.ingestSecret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch (err) {
      deps.logger.warn(`analytics ingest failed: ${(err as Error).message}`);
      return false;
    }
  }

  async function flushBacklog(): Promise<void> {
    while (backlog.length > 0) {
      const oldest = backlog[0];
      if (await post(oldest)) {
        backlog.shift();
      } else {
        break;
      }
    }
  }

  async function tick(): Promise<void> {
    await flushBacklog();
    const payload = await windowPayload();
    if (!(await post(payload))) {
      backlog.push(payload);
      if (backlog.length > MAX_BACKLOG_WINDOWS) {
        const dropped = backlog.splice(0, backlog.length - MAX_BACKLOG_WINDOWS);
        deps.logger.warn(`analytics backlog overflow: dropped ${dropped.length} window(s)`);
      }
    }
  }

  function schedule(): void {
    const tile = deps.windowSec * 1000;
    const now = Date.now();
    const delay = tile - (now % tile) + 25;
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
      schedule();
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      if (timer) return;
      // prime quickly so the first window lands shortly after boot
      setTimeout(() => void tick(), 5_000).unref?.();
      schedule();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    pushNow: () => tick(),
  };
}

export interface AnalyticsLiveScorer {
  start(): void;
  stop(): void;
  scoreNow(): Promise<void>;
}

export function createAnalyticsLiveScorer(deps: AnalyticsPusherDeps): AnalyticsLiveScorer {
  let unsubscribe: (() => void) | null = null;
  let inFlight = false;

  async function postLive(payload: unknown): Promise<boolean> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${deps.url}/v1/analytics/infer/current`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": deps.ingestSecret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok && res.status !== 404) {
        deps.logger.warn(`analytics live infer failed (HTTP ${res.status})`);
      }
      return res.ok;
    } catch (err) {
      deps.logger.warn(`analytics live infer failed: ${(err as Error).message}`);
      return false;
    }
  }

  async function scoreNow(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const from = Date.now() - deps.windowSec * 1000;
      const sys = await awaitMetrics(deps.metrics);
      const features = composeFeatures(deps.requests, collectRecords(deps.requests, from), sys);
      await postLive({ timestamp: Date.now(), features });
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = deps.metrics.subscribeSample(() => {
        void scoreNow();
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
    scoreNow,
  };
}

export const ANALYTICS_FEATURE_NAMES = FEATURE_NAMES;