import { createStore } from "./core";
import type { HostInfo, ModelMeta, SystemMetrics, SystemStatus } from "../types";

export interface StatusState {
  status: SystemStatus | null;
  meta: ModelMeta | null;
  host: HostInfo | null;
  sys: SystemMetrics | null;
  hist: { cpu?: (number | null)[]; mem?: (number | null)[]; temp?: (number | null)[]; tps?: (number | null)[]; rqm?: (number | null)[] };
  sparkMax: number;
  healthOk: boolean | null;
  readyLine: string;
}

const init: StatusState = {
  status: null,
  meta: null,
  host: null,
  sys: null,
  hist: { cpu: [], mem: [], temp: [], tps: [], rqm: [] },
  sparkMax: 0,
  healthOk: null,
  readyLine: "boot…",
};

export const statusStore = createStore<StatusState>(init);

export function pushSys(m: SystemMetrics, max = 120): void {
  const cap = (arr: (number | null)[]): (number | null)[] => (arr.length >= max ? arr.slice(arr.length - max + 1) : arr);
  statusStore.set((s) => ({
    ...s,
    sys: { ...s.sys, ...m },
    hist: {
      cpu: cap([...(s.hist.cpu ?? []), m.cpu ?? null]),
      mem: cap([...(s.hist.mem ?? []), m.memory ?? null]),
      temp: cap([...(s.hist.temp ?? []), m.temperature ?? null]),
      tps: cap([...(s.hist.tps ?? []), m.tokensPerSecond ?? null]),
      rqm: cap([...(s.hist.rqm ?? []), m.requestsPerMinute ?? null]),
    },
    sparkMax: Math.max(s.sparkMax, m.cpu ?? 0, m.memory ?? 0),
  }));
}