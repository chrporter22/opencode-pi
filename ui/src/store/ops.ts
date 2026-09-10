import { createStore } from "./core";
import type { RequestRecord } from "../types";

export interface Note {
  id: string;
  save: () => void;
}

export interface SyncResult {
  name: string;
  kind: string;
  note: string;
  latMs: number | null;
  status: "ok" | "err" | "warn";
  when: number;
}

export interface OpsState {
  logs: { ts: number; level: string; msg: string }[];
  waitLogs: number;
  requests: RequestRecord[];
  sessions: { id: string; model?: string; client?: string; prompt?: string; status: string; startedAt: number; time?: number; tps?: number; giant?: boolean }[];
  sessionMap: Record<string, { token?: number; giant?: boolean }>;
  sync: SyncResult[];
  notes: string | null;
}

const init: OpsState = {
  logs: [],
  waitLogs: 0,
  requests: [],
  sessions: [],
  sessionMap: {},
  sync: [],
  notes: null,
};

export const opsStore = createStore<OpsState>(init);

export function appendLog(msg: string, level = "info", ts?: number): void {
  const entry = { ts: ts ?? Date.now(), level, msg };
  opsStore.set((s) => {
    let logs = s.logs;
    if (logs.length > 1000) logs = logs.slice(logs.length - 1000);
    const merged = [...logs];
    const last = merged[merged.length - 1];
    if (last && last.msg === msg && Date.now() - last.ts < 1500) {
      merged[merged.length - 1] = { ...last, ts: Date.now() };
    } else {
      merged.push(entry);
    }
    return { ...s, logs: merged, waitLogs: merged.filter((l) => l.level === "debug" || l.level === "warn" || l.level === "error").length };
  });
}

export function upsertRequest(r: RequestRecord): void {
  opsStore.set((s) => {
    const maps = { ...s.sessionMap };
    if (r.source && r.id) maps[r.id] = { token: r.totalTokens, giant: totalTokens(r) > 0.85 * 8192 };
    const idx = s.requests.findIndex((x) => x.id === r.id);
    const requests = [...(s.requests.length >= 500 ? s.requests.slice(s.requests.length - 500) : s.requests)];
    if (idx >= 0) requests[idx] = r;
    else requests.push(r);
    const sessions = [...s.sessions];
    if (r.source && r.id) {
      const si = sessions.findIndex((x) => x.id === r.id);
      const rec = {
        id: r.id,
        model: r.model,
        client: r.source,
        prompt: firstPrompt(r),
        status: r.status,
        startedAt: r.startedAt,
        time: r.durationMs,
        tps: r.tokensPerSecond,
        giant: totalTokens(r) > 0.85 * 8192,
      };
      if (si >= 0) sessions[si] = rec;
      else sessions.push(rec);
    }
    return { ...s, requests, sessions, sessionMap: maps };
  });
}

function totalTokens(r: RequestRecord): number {
  return r.totalTokens ?? (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
}

function firstPrompt(r: RequestRecord): string | undefined {
  if (!r.error) return undefined;
  const m = String(r.error).match(/"(https?:\/\/[^"\s]+)"/);
  return m ? m[1] : undefined;
}

export function pushSync(r: SyncResult): void {
  opsStore.set((s) => ({ ...s, sync: [...s.sync.slice(-49), r] }));
}