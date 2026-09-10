import { localKey } from "../store/ui";
import { appendLog, upsertRequest } from "../store/ops";
import { pushSys, statusStore } from "../store/status";
import { rafBatch } from "./useFrame";
import { analyticsStore, setInfer, setMeta, setRisk } from "../store/analytics";
import type { AnalyticsInfer, AnalyticsRisk } from "../types";
import { extractFeatures } from "../store/analytics";

let ws: WebSocket | null = null;
let wire = 0;
const backoffMin = 1500;
const backoffMax = 30000;
let backoff = backoffMin;

export function connectWs(): void {
  const key = localKey();
  if (!key) {
    closeWs();
    statusStore.set({ healthOk: false });
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?key=${encodeURIComponent(key)}`);
  ws.onopen = () => {
    backoff = backoffMin;
    statusStore.set({ healthOk: true });
  };
  ws.onmessage = (ev) => {
    let obj: { type?: string } & Record<string, unknown>;
    try {
      obj = JSON.parse(String(ev.data));
    } catch {
      appendLog(String(ev.data).slice(0, 400), "info");
      return;
    }
    route(obj);
  };
  ws.onerror = () => {
    statusStore.set({ healthOk: false });
  };
  ws.onclose = () => {
    statusStore.set({ healthOk: false });
    const t = setTimeout(() => {
      clearTimeout(t);
      const cur = wire;
      if (cur !== wire) return;
      backoff = Math.min(backoffMax, backoff * 2);
      connectWs();
    }, backoff);
  };
}

export function closeWs(): void {
  wire++;
  if (ws) {
    ws.close();
    ws = null;
  }
  const t = setTimeout(() => {
    clearTimeout(t);
    statusStore.set({ healthOk: false });
  }, 300);
}

function route(obj: { type?: string } & Record<string, unknown>): void {
  const t = obj.type ?? "";
  if (t === "log") {
    appendLog(String(obj.message ?? ""), String(obj.level ?? "info"));
    return;
  }
  if (t === "request.started" || t === "request.completed" || t === "request.error") {
    upsertRequest({
      id: String(obj.id ?? ""),
      method: String(obj.method ?? ""),
      path: String(obj.path ?? ""),
      model: String(obj.model ?? ""),
      source: String(obj.source ?? ""),
      ip: String(obj.ip ?? ""),
      status: String(obj.status ?? ""),
      startedAt: Number(obj.timestamp ?? Date.now()),
      durationMs: obj.durationMs as number | undefined,
      promptTokens: obj.promptTokens as number | undefined,
      completionTokens: obj.completionTokens as number | undefined,
      totalTokens: obj.totalTokens as number | undefined,
      tokensPerSecond: obj.tokensPerSecond as number | undefined,
      error: obj.error as string | undefined,
    });
    return;
  }
  if (t === "system.metrics") {
    rafBatch(() => {
      pushSys(obj as typeof obj & { cpu?: number; memory?: number; temperature?: number; tokensPerSecond?: number; requestsPerMinute?: number });
      const s = statusStore.get();
      if (!s.status) statusStore.set({ status: { gateway: "online", llama: "?", model: "?", modelLoaded: false } });
    });
    return;
  }
  if (t === "analytics.risk") {
    rafBatch(() => setRisk(obj as unknown as AnalyticsRisk));
    return;
  }
  if (t === "analytics.infer") {
    rafBatch(() => setInfer(obj as unknown as AnalyticsInfer));
    return;
  }
  if (t === "analytics.meta") {
    setMeta(obj as unknown as Parameters<typeof setMeta>[0]);
    extractFeatures(analyticsStore.get());
    return;
  }
  if (t === "training.progress") {
    const m = (obj.metrics as { f1?: number }) ?? {};
    const cfg = obj.config as { trial?: number; trials?: number; layers?: number; units?: number; lr?: number; batch?: number } | undefined;
    const line =
      "trial " + (cfg?.trial ?? "?") + "/" + (cfg?.trials ?? "?") +
      " F1 " + (m.f1 != null ? m.f1.toFixed(3) : "—") +
      (cfg ? " lr" + cfg.lr + " batch" + cfg.batch : "");
    analyticsStore.set((s) => ({
      ...s,
      trials: { ...s.trials, progress: truncLine(s.trials.progress + (s.trials.progress ? "\n" : "") + line) },
    }));
    return;
  }
  if (t === "training.done") {
    analyticsStore.set((s) => ({
      ...s,
      trials: { ...s.trials, bestSoFar: (obj.best as never) ?? s.trials.bestSoFar },
    }));
    return;
  }
  if (t === "training.started") analyticsStore.set((s) => ({ ...s, trials: { ...s.trials, progress: "" } }));
  appendLog(streamNote(obj), "info");
  if (t === "gateway.status" || t === "llama.status" || t === "model.status") {
    statusStore.set((s) => ({ ...s, status: { ...(s.status ?? {}), gateway: t === "gateway.status" ? String(obj.status ?? s.status?.gateway ?? "?") : s.status?.gateway ?? "?", llama: t === "llama.status" ? String(obj.status ?? s.status?.llama ?? "?") : s.status?.llama ?? "?", model: t === "model.status" ? String(obj.status ?? obj.model ?? obj.file ?? s.status?.model ?? "?") : s.status?.model ?? "?" } }));
  }
}

function truncLine(s: string): string {
  const lines = s.split("\n");
  return lines.slice(-6).join("\n");
}

function streamNote(obj: Record<string, unknown>): string {
  const t = obj.type;
  const m = (obj.metrics ?? {}) as { f1?: number; accuracy?: number };
  if (t === "analytics.risk") return "risk " + (obj.level ?? "?") + " · T² " + (obj.t2 != null ? (obj.t2 as number).toFixed(2) : "?") + " · p " + (obj.pValue != null ? (obj.pValue as number).toExponential(2) : "?") + (obj.nnRisk ? " · log-reg " + obj.nnRisk : "");
  if (t === "analytics.infer") return "log-reg infer → " + (obj.nnRisk ?? "?");
  if (t === "training.progress") return "trial " + (obj.trial ?? "?") + "/" + (obj.trials ?? "?") + " · F1 " + (m.f1 != null ? m.f1.toFixed(3) : "?");
  if (t === "training.done") return obj.best ? "done · F1 " + ((obj.best as { f1?: number }).f1 != null ? (obj.best as { f1?: number }).f1!.toFixed(3) : "?") : "training done";
  if (t === "training.started") return "training started" + (obj.rows != null ? " · rows " + obj.rows : "");
  if (t === "training.skipped") return "training skipped" + (obj.reason ? " · " + String(obj.reason).slice(0, 80) : "");
  if (t === "training.error") return "training error" + (obj.message ? " · " + String(obj.message).slice(0, 140) : "");
  if (t && String(t).startsWith("training.")) return String(t).replace("training.", "training · ");
  if (t && String(t).startsWith("analytics.")) return String(t) + (obj.message ? " · " + String(obj.message).slice(0, 80) : "");
  if (t === "gateway.status") return "gateway " + (obj.status ?? "");
  if (t === "llama.status") return "llama " + (obj.status ?? "");
  if (t === "model.status") return "model " + (obj.status ?? obj.state ?? obj.file ?? "");
  return String(t) + (obj.message ? " · " + String(obj.message).slice(0, 80) : "");
}

export function wsOpen(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}