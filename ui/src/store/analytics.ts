import { createStore } from "./core";
import type {
  AnalyticsConfig,
  AnalyticsInfer,
  AnalyticsMeta,
  AnalyticsRisk,
  BacktestRun,
  BacktestSample,
  BestModel,
  CloudPoint,
  FeatureFilterEntry,
  HistoricWindow,
  InputFeature,
  LatencyPoint,
  RegisteredModel,
  TrainingRun,
  TrainingStatus,
} from "../types";

export interface LiveNn {
  label: string | null;
  prob: number[] | null;
  ms: number | null;
  when: number;
}

export interface TrialInfo {
  bestSoFar?: BestModel;
  progress: string;
}

export interface AnalyticsState {
  risk: AnalyticsRisk | null;
  infer: LiveNn | null;
  meta: AnalyticsMeta | null;
  cfg: AnalyticsConfig | null;
  training: TrainingStatus | null;
  models: RegisteredModel[];
  runs: TrainingRun[];
  cloud: CloudPoint[];
  hist: HistoricWindow[];
  latency: LatencyPoint[];
  trials: TrialInfo;
  inputFeatures: InputFeature[];
  inputFilter: FeatureFilterEntry[];
  backtest: BacktestRun[];
  backtestSamples: BacktestSample[];
  backtestActive: boolean;
  ctxHist: number[];
  loading: boolean;
  lastLoad: number;
  lastCloudMs: number | null;
  proc: ApiProc | null;
}

const init: AnalyticsState = {
  risk: null,
  infer: null,
  meta: null,
  cfg: null,
  training: null,
  models: [],
  runs: [],
  cloud: [],
  hist: [],
  latency: [],
  trials: { progress: "" },
  inputFeatures: [],
  inputFilter: [],
  backtest: [],
  backtestSamples: [],
  backtestActive: false,
  ctxHist: [],
  loading: false,
  lastLoad: 0,
  lastCloudMs: null,
  proc: null,
};

export const analyticsStore = createStore<AnalyticsState>(init);

export interface ApiProc {
  scores: number[][];
  bands: number[];
  labels?: string[];
}

export function setRisk(r: AnalyticsRisk): void {
  analyticsStore.set((s) => {
    const ctx = Number.isFinite(r.contextWindows) ? Number(r.contextWindows) : null;
    const ctxHist = ctx != null ? [...s.ctxHist, ctx].slice(-60) : s.ctxHist;
    return {
      ...s,
      risk: r,
      ctxHist,
      infer: r.nnRisk
        ? { label: r.nnRisk, prob: r.nnProb as number[] | null, ms: r.nnLatencyMs ?? null, when: Date.now() }
        : s.infer,
      meta: r.nnRisk
        ? { ...(s.meta ?? {}), latency: { lastNnMs: r.nnLatencyMs ?? s.meta?.latency?.lastNnMs, lastComputeMs: r.computeMs ?? s.meta?.latency?.lastComputeMs, nnRuns: (s.meta?.latency?.nnRuns ?? 0) + 1 } }
        : s.meta,
    };
  });
}

export function setInfer(i: AnalyticsInfer): void {
  analyticsStore.set((s) => ({
    ...s,
    infer: { label: i.nnRisk ?? null, prob: i.nnProb ?? null, ms: i.nnLatencyMs ?? null, when: Date.now() },
    meta: {
      ...(s.meta ?? {}),
      latency: { lastNnMs: i.nnLatencyMs ?? s.meta?.latency?.lastNnMs, lastComputeMs: s.meta?.latency?.lastComputeMs, nnRuns: (s.meta?.latency?.nnRuns ?? 0) + 1 },
    },
  }));
}

export function setMeta(m: AnalyticsMeta): void {
  analyticsStore.set((s) => {
    const features = m.inputFeatures ?? s.inputFeatures;
    const filter = m.inputFilter ?? s.inputFilter;
    const cfgs = s.cfg;
    return { ...s, meta: m, inputFeatures: features, inputFilter: filter, cfg: cfgs };
  });
}

export function setCfg(c: AnalyticsConfig): void {
  analyticsStore.set({ cfg: c });
}

export function extractFeatures(s: AnalyticsState): void {
  const f = s.meta?.inputFeatures ?? [];
  const fl = f.filter((x) => Number(x.value) !== 0 && x.name !== "timestamp");
  analyticsStore.set({ inputFeatures: fl });
}

export function syncFilterFromFeatures(list: InputFeature[]): FeatureFilterEntry[] {
  return list.map((f) => ({ name: f.name, enabled: true }));
}