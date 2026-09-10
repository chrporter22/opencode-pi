import { api, getHealth } from "./api";
import { statusStore, pushSys } from "../store/status";
import { analyticsStore, setMeta, setCfg, setRisk, extractFeatures } from "../store/analytics";
import { appendLog, upsertRequest } from "../store/ops";
import { localKey } from "../store/ui";
import type {
  AnalyticsConfig,
  AnalyticsMeta,
  AnalyticsRisk,
  BacktestRun,
  BacktestSample,
  CloudPoint,
  HistoricWindow,
  HostInfo,
  LatencyPoint,
  ModelMeta,
  RegisteredModel,
  RequestRecord,
  SystemMetrics,
  SystemStatus,
  TrainingRun,
  TrainingStatus,
} from "../types";

let loaded = false;

export async function loadLogHistory(): Promise<void> {
  if (loaded || !localKey()) return;
  loaded = true;
  try {
    const r = await api<{ entries: { msg: string; level: string }[] }>("/api/logs");
    for (const e of r.entries ?? []) appendLog(e.msg, e.level);
  } catch {}
}

export async function refresh(): Promise<void> {
  if (!localKey()) {
    statusStore.set({ healthOk: false });
    return;
  }
  try {
    const health = await getHealth();
    statusStore.set({ healthOk: !!(health && health.ok !== false) });
    const [s, m, sys] = await Promise.all([
      api<SystemStatus>("/api/status"),
      api<ModelMeta>("/api/model"),
      api<SystemMetrics>("/api/system"),
    ]);
    statusStore.set({ status: s, meta: m, healthOk: true });
    pushSys(sys);
    void loadHost();
    void loadAnalytics();
    void loadRequests();
  } catch {}
}

export async function loadHost(): Promise<void> {
  try {
    const h = await api<HostInfo>("/api/system/host");
    statusStore.set({ host: h });
  } catch {}
}

export async function loadRequests(): Promise<void> {
  try {
    const r = await api<{ entries?: RequestRecord[] }>("/api/requests");
    for (const rec of r.entries ?? []) {
      upsertRequest({ ...rec, startedAt: rec.startedAt ?? Date.now() });
    }
  } catch {}
}

export async function loadAnalytics(): Promise<void> {
  try {
    const [risk, cfg, meta, training] = await Promise.all([
      api<AnalyticsRisk>("/api/analytics/risk").catch(() => null),
      api<AnalyticsConfig>("/api/analytics/config").catch(() => null),
      api<AnalyticsMeta>("/api/analytics/meta").catch(() => null),
      api<TrainingStatus>("/api/analytics/training/status").catch(() => null),
    ]);
    if (risk) setRisk(risk);
    if (cfg) setCfg(cfg);
    if (meta) {
      setMeta(meta);
      extractFeatures(analyticsStore.get());
    }
    if (training) analyticsStore.set({ training });
    analyticsStore.set({ lastLoad: Date.now(), loading: false });
  } catch {
    analyticsStore.set({ loading: false });
  }
}

export async function loadCloud(): Promise<void> {
  try {
    const t0 = performance.now();
    const cloud = await api<CloudPoint[]>("/api/analytics/pca/cloud?limit=300");
    analyticsStore.set({ cloud, lastCloudMs: Math.round(performance.now() - t0) });
  } catch {}
}

export async function loadHistoric(): Promise<void> {
  try {
    const hist = await api<HistoricWindow[]>("/api/analytics/historic/windows?limit=200");
    analyticsStore.set({ hist });
  } catch {}
}

export async function loadLatency(): Promise<void> {
  try {
    const latency = await api<LatencyPoint[]>("/api/analytics/latency/history?limit=200");
    analyticsStore.set({ latency });
  } catch {}
}

export async function loadModels(): Promise<void> {
  try {
    const models = await api<RegisteredModel[]>("/api/analytics/models");
    analyticsStore.set({ models });
  } catch {}
}

export async function loadRuns(): Promise<void> {
  try {
    const runs = await api<TrainingRun[]>("/api/analytics/training/runs?limit=20");
    analyticsStore.set({ runs });
  } catch {}
}

export function loadMlPage(): void {
  void loadCloud();
  void loadHistoric();
  void loadLatency();
  void loadModels();
  void loadRuns();
  void loadBacktest();
}

export async function loadBacktest(): Promise<void> {
  try {
    const [runs, samples, status] = await Promise.all([
      api<BacktestRun[]>("/api/analytics/backtest/runs?limit=20").catch(() => []),
      api<BacktestSample[]>("/api/analytics/backtest/samples?limit=200").catch(() => []),
      api<{ active?: boolean }>("/api/analytics/backtest/status").catch(() => ({} as { active?: boolean })),
    ]);
    analyticsStore.set({
      backtest: runs,
      backtestSamples: samples,
      backtestActive: !!status.active,
    });
  } catch {}
}