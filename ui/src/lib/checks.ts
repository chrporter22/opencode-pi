import { localInferenceKey, localKey } from "../store/ui";
import { pushSync, type SyncResult } from "../store/ops";
import { fmtBytes } from "./fmt";
import type { ConnCheckResult } from "../types";

export interface CheckDef {
  id: string;
  name: string;
  kind: "connection" | "pipeline";
  needKey?: boolean;
  needInference?: boolean;
  run: (hdrs: { [ADMIN: string]: string } | null, ikey: string) => Promise<Omit<ConnCheckResult, "when">>;
}

const ADMIN = "x-api-key";

export const CHECKS: CheckDef[] = [
  { id: "gw", name: "gateway", kind: "connection", run: async () => {
      const r = await fetch("/health");
      return { ok: r.ok, note: "http " + r.status };
    } },
  { id: "sys", name: "host metrics", kind: "connection", needKey: true, run: async (hdrs) => {
      const r = await fetch("/api/system", { headers: hdrs as Record<string, string> });
      const b = (await r.json()) as { cpu?: number; memory?: number };
      return { ok: r.ok, note: "cpu " + (b.cpu != null ? b.cpu.toFixed(0) + "%" : "—") + " · mem " + (b.memory != null ? b.memory.toFixed(0) + "%" : "—") };
    } },
  { id: "llama", name: "llama-server", kind: "connection", needKey: true, run: async (hdrs) => {
      const s = (await (await fetch("/api/status", { headers: hdrs as Record<string, string> })).json()) as { llama?: string; modelLoaded?: boolean };
      return { ok: s.llama === "ready" || s.llama === "online", note: "llama " + (s.llama ?? "?") + (s.modelLoaded ? " · loaded" : "") };
    } },
  { id: "model", name: "model store", kind: "connection", needKey: true, run: async (hdrs) => {
      const m = (await (await fetch("/api/model", { headers: hdrs as Record<string, string> })).json()) as { installed?: boolean; loadingStatus?: string; name?: string; quantization?: string };
      return { ok: !!m.installed && m.loadingStatus !== "error", note: (m.quantization || m.name || "model") + (m.installed ? " · installed" : " · missing") };
    } },
  { id: "logs", name: "logs", kind: "connection", needKey: true, run: async (hdrs) => {
      const r = await fetch("/api/logs", { headers: hdrs as Record<string, string> });
      return { ok: r.ok, note: "http " + r.status };
    } },
  { id: "reqs", name: "requests", kind: "connection", needKey: true, run: async (hdrs) => {
      const r = await fetch("/api/requests", { headers: hdrs as Record<string, string> });
      const b = (await r.json()) as { entries?: unknown[] };
      return { ok: r.ok, note: (b.entries ?? []).length + " recorded" };
    } },
  { id: "oc", name: "opencode agent", kind: "connection", needInference: true, run: async (_hdrs, ikey) => {
      const r = await fetch("/v1/models", { headers: { Authorization: "Bearer " + ikey } });
      const b = (await r.json().catch(() => ({}))) as { data?: { id?: string }[] };
      const ids = (b.data ?? []).map((m) => m.id).join(", ");
      return { ok: r.ok, note: ids ? "serving " + ids : "http " + r.status };
    } },
  { id: "whsql", name: "warehouse sqlite", kind: "connection", needKey: true, run: async (hdrs) => {
      const r = await fetch("/api/analytics/warehouse/sql", { headers: hdrs as Record<string, string> });
      const b = (await r.json()) as { tables?: { table: string; rows: number }[]; windows?: number };
      if (!r.ok) return { ok: false, note: "http " + r.status, data: null };
      return { ok: true, note: (b.tables ?? []).length + " tables · " + (b.windows ?? 0) + " windows", data: b };
    } },
  { id: "whredis", name: "warehouse redis", kind: "connection", needKey: true, run: async (hdrs) => {
      const r = await fetch("/api/analytics/warehouse/redis", { headers: hdrs as Record<string, string> });
      const b = (await r.json()) as { available?: boolean; keys?: { key: string }[] };
      return { ok: r.ok && b.available !== false, note: b.available ? (b.keys ?? []).length + " keys" : "not available", data: b };
    } },
  { id: "mlm", name: "ml artifact store", kind: "connection", needKey: true, run: async (hdrs) => {
      const r = await fetch("/api/analytics/meta", { headers: hdrs as Record<string, string> });
      const b = (await r.json().catch(() => ({}))) as { model?: { active?: boolean; name?: string; tfliteBytes?: number; kerasBytes?: number } };
      if (!r.ok) return { ok: false, note: "http " + r.status, data: null };
      const m = b.model ?? {};
      return {
        ok: true,
        note: m.active ? (m.name ?? "model") + " active · " + fmtBytes(m.tfliteBytes) : "no trained model yet",
        data: b,
      };
    } },
  { id: "p_inf", name: "llama inference", kind: "pipeline", needKey: true, run: async (hdrs) => {
      const s = (await (await fetch("/api/status", { headers: hdrs as Record<string, string> })).json()) as { llama?: string };
      return { ok: s.llama === "ready" || s.llama === "online", note: "endpoint /v1/chat/completions" };
    } },
  { id: "p_up", name: "model update", kind: "pipeline", needKey: true, run: async (hdrs) => {
      const m = (await (await fetch("/api/model", { headers: hdrs as Record<string, string> })).json()) as { loadingStatus?: string };
      return { ok: m.loadingStatus !== "error", note: m.loadingStatus || "idle" };
    } },
  { id: "p_str", name: "request streams", kind: "pipeline", needKey: true, run: async (hdrs) => {
      const b = (await (await fetch("/api/requests", { headers: hdrs as Record<string, string> })).json()) as { entries?: { status?: string }[] };
      const entries = b.entries ?? [];
      const active = entries.filter((e) => e.status === "started").length;
      return { ok: true, note: active > 0 ? active + " active" : "idle (" + entries.length + " recent)" };
    } },
];

export function adminHdrs(): { [ADMIN: string]: string } | null {
  const k = localKey();
  return k ? { [ADMIN]: k } : null;
}

export async function runCheck(c: CheckDef, hdrs: { [ADMIN: string]: string } | null, ikey: string): Promise<ConnCheckResult> {
  const t0 = performance.now();
  const res = await c
    .run(hdrs, ikey)
    .then((r) => ({ ...r, ms: Math.round(performance.now() - t0), when: Date.now() }))
    .catch((e) => ({ ok: false, note: e.message || "error", ms: Math.round(performance.now() - t0) as number, when: Date.now() }));
  return res;
}

async function syncOne(c: CheckDef): Promise<SyncResult> {
  const hdrs = adminHdrs();
  const ikey = localInferenceKey().trim();
  if (c.needKey && !hdrs) {
    return { name: c.name, kind: c.kind, note: "admin key required", latMs: null, status: "warn", when: Date.now() };
  }
  if (c.needInference && !ikey) {
    return { name: c.name, kind: c.kind, note: "inference key required", latMs: null, status: "warn", when: Date.now() };
  }
  const r = await runCheck(c, hdrs, ikey);
  return {
    name: c.name,
    kind: c.kind,
    note: r.note ?? (r.ok ? "ok" : "failed"),
    latMs: r.ms ?? null,
    status: r.ok ? "ok" : "err",
    when: r.when,
  };
}

export async function syncAll(): Promise<{ ok: number; fail: number; skip: number }> {
  let ok = 0;
  let fail = 0;
  let skip = 0;
  for (const c of CHECKS) {
    const r = await syncOne(c);
    if (r.status === "ok") ok++;
    else if (r.status === "err") fail++;
    else skip++;
    pushSync(r);
  }
  return { ok, fail, skip };
}

export async function syncConnection(id: string): Promise<void> {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) return;
  const r = await syncOne(c);
  pushSync(r);
}