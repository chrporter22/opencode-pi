import { describe, expect, it } from "vitest";
import {
  ANALYTICS_FEATURE_NAMES,
  createAnalyticsPusher,
  type AnalyticsPusherDeps,
} from "../src/modules/analytics/pusher.js";

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

function fakeDeps(overrides: Partial<AnalyticsPusherDeps> = {}): AnalyticsPusherDeps {
  return {
    url: "http://analytics:8081",
    ingestSecret: "s3cret",
    windowSec: 60,
    requests: {
      snapshot: () => [
        ...overrides.requests?.snapshot?.() ?? [],
      ],
      requestsPerMinute: () => 30,
      applyTaskTiming: () => {},
      subscribe: () => () => {},
    } as never,
    metrics: {
      snapshot: async () => ({
        cpu: 50,
        memory: 40,
        temperature: 42,
        disk: { usedPercent: 55 },
        timestamp: Date.now(),
        tokensPerSecond: 12,
      }),
      subscribeSample: () => () => {},
      stop: () => {},
    } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {}, snapshot: () => [] } as never,
    ...overrides,
  };
}

describe("analytics pusher feature window", () => {
  it("exports the P=10 feature vector in FEATURE_NAMES order", () => {
    expect(ANALYTICS_FEATURE_NAMES).toEqual(FEATURE_NAMES);
    expect(ANALYTICS_FEATURE_NAMES).toHaveLength(10);
  });

  it("posts a window payload with exactly 10 features + per-request features", async () => {
    let captured: unknown;
    const pusher = createAnalyticsPusher(
      fakeDeps({
        metrics: {
          snapshot: async () => ({
            cpu: 50,
            memory: 40,
            temperature: 42,
            disk: { usedPercent: 55 },
            timestamp: Date.now(),
            tokensPerSecond: 12,
          }),
          subscribeSample: () => () => {},
          stop: () => {},
        } as never,
        fetchImpl: async (_url, init) => {
          captured = JSON.parse(String(init?.body));
          return { ok: true, status: 200 } as Response;
        },
      })
    );
    // sanity: snapshot defaults to empty so the window is a pure feature vector
    await pusher.pushNow();
    const payload = captured as { features: number[]; requests: unknown[] };
    expect(payload).toBeDefined();
    expect(payload.features).toHaveLength(10);
    expect(payload.requests).toEqual([]);
    expect(payload.features.every((v) => Number.isFinite(v))).toBe(true);
  });
});