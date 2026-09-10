import type { RiskLabel } from "../types";

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(0) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export function fmtUptime(s: number | null | undefined): string {
  if (s == null) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (d > 0 ? d + "d " : "") + h + "h " + m + "m";
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null) return "—";
  return v.toFixed(digits) + "%";
}

export function fmtTemp(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toFixed(1) + "°C";
}

export function fmtToks(r: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): string {
  return [r.promptTokens ?? "—", r.completionTokens ?? "—", r.totalTokens ?? "—"].join("/");
}

export function fmtDur(ms: number | null | undefined): string {
  return ms == null ? "—" : ms + " ms";
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c],
  );
}

export function shortId(id?: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

export function lastNum(a: Array<number | null | undefined>): number | null {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i] as number;
  return null;
}

export function fmtDateTime(ts?: string | number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function fmtTime(ts?: number | string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "—" : d.toLocaleTimeString();
}

export function fmtExponential(v: number | null | undefined, digits = 2): string {
  if (v == null) return "—";
  return v.toExponential(digits);
}

export function pct(n: number, digits = 0): string {
  return (n * 100).toFixed(digits) + "%";
}

export type Chipless = "ok" | "err" | "warn" | null;

export function chipState(v: unknown): Chipless {
  const s = String(v);
  const ok = ["ready", "online", "loaded", "true", "ok", "200", "enabled", "active"];
  const err = ["error", "stopping", "offline", "false", "failed", "missing"];
  if (ok.includes(s)) return "ok";
  if (err.includes(s)) return "err";
  if (s !== "—" && s !== "") return "warn";
  return null;
}

export const NZ: RiskLabel[] = ["normal", "watch", "high"];

export function nnTxt(label?: string | null, prob?: number[] | null): string {
  if (!label) return "—";
  let txt = label;
  if (Array.isArray(prob) && prob.length === 3) {
    const idx = NZ.indexOf(label as RiskLabel);
    const pi = idx >= 0 ? prob[idx] : Math.max(...prob);
    txt += " " + (pi * 100).toFixed(0) + "%";
    const second = prob
      .map((p, i) => ({ p, i }))
      .filter((o) => o.i !== idx && o.p * 100 >= 10)
      .sort((a, b) => b.p - a.p)[0];
    if (second) txt += " · " + NZ[second.i] + " " + (second.p * 100).toFixed(0) + "%";
  }
  return txt;
}