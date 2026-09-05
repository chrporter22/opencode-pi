export type RequestStatus = "started" | "completed" | "error";

export interface RequestRecord {
  id: string;
  method: string;
  path: string;
  model: string;
  status: RequestStatus;
  startedAt: number;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokensPerSecond: number | null;
  error: string | null;
}

export interface RequestContext {
  id: string;
  method: string;
  path: string;
  model: string;
}

export interface RequestUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface RequestTracker {
  start(ctx: RequestContext): void;
  complete(id: string, usage: RequestUsage): void;
  fail(id: string, error: string): void;
  applyTaskTiming(timing: RequestUsage): void;
  snapshot(): RequestRecord[];
  subscribe(cb: (record: RequestRecord) => void): () => void;
  requestsPerMinute(): number;
}

export interface RequestTrackerOptions {
  maxRecords?: number;
}

export const RATE_WINDOW_MS = 60_000;
export const RATE_PRUNE_MS = 120_000;

export function countRequestRate(startTimes: number[], now: number, windowMs = RATE_WINDOW_MS): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (const t of startTimes) {
    if (t >= cutoff) count += 1;
  }
  return count;
}

const EMPTY_USAGE: RequestUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

export function createRequestTracker(opts: RequestTrackerOptions = {}): RequestTracker {
  const maxRecords = opts.maxRecords ?? 200;
  const ring: RequestRecord[] = [];
  const subscribers = new Set<(record: RequestRecord) => void>();
  const pendingTimings = new Map<string, RequestUsage>();
  const startTimes: number[] = [];

  function pruneStarts(): void {
    const cutoff = Date.now() - RATE_PRUNE_MS;
    while (startTimes.length && startTimes[0] < cutoff) startTimes.shift();
  }

  function emit(record: RequestRecord): void {
    for (const cb of subscribers) cb(record);
  }

  function push(record: RequestRecord): void {
    ring.push(record);
    if (ring.length > maxRecords) ring.splice(0, ring.length - maxRecords);
    emit(record);
  }

  function findRecord(id: string): RequestRecord | undefined {
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i].id === id) return ring[i];
    }
    return undefined;
  }

  return {
    start(ctx) {
      pruneStarts();
      startTimes.push(Date.now());
      push({
        id: ctx.id,
        method: ctx.method,
        path: ctx.path,
        model: ctx.model,
        status: "started",
        startedAt: Date.now(),
        durationMs: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        tokensPerSecond: null,
        error: null,
      });
    },
    complete(id, usage) {
      const record = findRecord(id);
      if (!record || record.status !== "started") return;
      record.status = "completed";
      const u = usage ?? EMPTY_USAGE;
      const t = pendingTimings.get(id) ?? EMPTY_USAGE;
      pendingTimings.delete(id);
      record.promptTokens = u.promptTokens ?? t.promptTokens ?? null;
      record.completionTokens = u.completionTokens ?? t.completionTokens ?? null;
      record.totalTokens = u.totalTokens ?? t.totalTokens ?? null;
      record.durationMs = Date.now() - record.startedAt;
      record.tokensPerSecond =
        record.completionTokens != null && record.durationMs > 0
          ? record.completionTokens / (record.durationMs / 1000)
          : null;
      emit(record);
    },
    fail(id, error) {
      const record = findRecord(id);
      if (!record || record.status !== "started") return;
      pendingTimings.delete(id);
      record.status = "error";
      record.error = error;
      record.durationMs = Date.now() - record.startedAt;
      emit(record);
    },
    applyTaskTiming(timing) {
      for (let i = ring.length - 1; i >= 0; i--) {
        const record = ring[i];
        if (record.status === "started") {
          pendingTimings.set(record.id, timing);
          return;
        }
      }
      for (let i = ring.length - 1; i >= 0; i--) {
        const record = ring[i];
        if (record.status === "completed" && record.totalTokens == null) {
          record.promptTokens = timing.promptTokens;
          record.completionTokens = timing.completionTokens;
          record.totalTokens = timing.totalTokens;
          record.tokensPerSecond =
            record.completionTokens != null && record.durationMs != null && record.durationMs > 0
              ? record.completionTokens / (record.durationMs / 1000)
              : null;
          emit(record);
          return;
        }
      }
    },
    snapshot: () => [...ring],
    requestsPerMinute: () => {
      pruneStarts();
      return countRequestRate(startTimes, Date.now());
    },
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}