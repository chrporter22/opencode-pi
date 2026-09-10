import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStoreSlice } from "../store/core";
import { analyticsStore, setCfg, setInfer, setMeta } from "../store/analytics";
import { appendLog } from "../store/ops";
import { setView } from "../store/ui";
import { api } from "../lib/api";
import { loadBacktest, loadLatency, loadMlPage } from "../lib/load";
import { fmtBytes } from "../lib/fmt";
import { VIRIDIS, shortLabel } from "../lib/math";
import { useFrame, usePageVisible } from "../lib/useFrame";
import type {
  AnalyticsConfig,
  AnalyticsInfer,
  AnalyticsMeta,
  BacktestRun,
  CloudPoint,
  ModelMetadata,
  RegisteredModel,
} from "../types";
import { Card, Chip } from "./ui";
import { Spark } from "./Spark";

interface AnalyticsConfigPatch {
  ingestEnabled: boolean;
  ewmaDecay?: number;
  pcaComponents?: number;
  watchZ?: number;
  highZ?: number;
  cron?: string | null;
  featureFilter?: boolean[];
  minRows?: number;
  epochs?: number;
  batch?: number;
  trials?: number;
  validation?: number;
  seed?: number;
}

const ML_DIM_SETS = [[0, 1, 2], [1, 2, 3], [2, 0, 3], [0, 3, 1]] as const;
const FEAT10 = ["log1p_requestsPerMinute", "errorRate", "log1p_p95LatMs", "log1p_p99LatMs", "log1p_p95TokPerSec", "log1p_p99TokPerSec", "cpuFrac", "memFrac", "tempC", "diskFrac"];
const BOX_LABELS: Record<string, string> = { cpuFrac: "cpu", memFrac: "mem", tempC: "temp", log1p_p95TokPerSec: "tok/s" };
const BOX_FEATURES = ["cpuFrac", "memFrac", "tempC", "log1p_p95TokPerSec"];

function viridis(t: number): string {
  t = Math.max(0, Math.min(1, t));
  const i = Math.min(VIRIDIS.length - 2, Math.floor(t * (VIRIDIS.length - 1)));
  const f = t * (VIRIDIS.length - 1) - i;
  const a = VIRIDIS[i], b = VIRIDIS[i + 1];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return "rgb(" + c.join(",") + ")";
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

interface ProjPoint {
  p: CloudPoint;
  d: number;
  px: number;
  py: number;
  size: number;
  mag: number;
}
let lastProj: ProjPoint[] = [];

function pct(z: number, v: number, scale: number): number {
  return Math.max(0, Math.min(100, 50 + ((v - z) / scale) * 50));
}
function distInfo(z: number, watch: number, high: number): string {
  const a = Math.abs(z);
  if (a <= watch) return "normal " + ((a / watch) * 100).toFixed(0) + "% into watch band";
  if (a <= high) return "watch +" + (((a - watch) / (high - watch)) * 100).toFixed(0) + "%";
  return "high +" + (((a - high) / high) * 100).toFixed(0) + "% past";
}
function fmtMs(v: number | null | undefined, digits?: number): string {
  if (v == null) return "—";
  return (digits == null ? v.toFixed(2) : v.toFixed(digits)) + "ms";
}

function LogRegScorecard() {
  const { risk, infer, cfg, meta } = useStoreSlice(analyticsStore, (s) => ({ risk: s.risk, infer: s.infer, cfg: s.cfg, meta: s.meta }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pipeLabel = risk?.level ?? null;
  const label = infer?.label ?? risk?.nnRisk ?? null;
  const prob: number[] | null = infer?.prob ?? risk?.nnProb ?? null;
  const pc = (p: number) => (p >= 0.1 ? (p * 100).toFixed(0) + "%" : (p * 100).toFixed(1) + "%");
  const watch = Number(cfg?.watchZ ?? 1.0);
  const high = Number(cfg?.highZ ?? 1.5);
  const scores = (risk?.pcScores ?? []).slice(0, 4);
  const totalVar4 = (risk?.variance ?? []).slice(0, 4).reduce((a, b) => a + b, 0);
  const scale = Math.max(high * 1.6, ...scores.map((c) => Math.abs(c.z) * 1.1), 0.5);

  const runInfer = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api<AnalyticsInfer>("/api/analytics/infer", { method: "POST", body: {} });
      setInfer(res);
      appendLog("ml action infer ok", "info");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      appendLog("ml action infer failed: " + msg, "err");
    }
    setBusy(false);
  };

  return (
    <Card cls="ac-model span2" title="ML risk scorecard">
      <div className="row actions mb-1">
        <button className="btn-mini" disabled={busy} onClick={() => void runInfer()}>{busy ? "…" : "Run log-reg inference (TF-lite)"}</button>
        {err ? <span className="muted" style={{ fontSize: 11, color: "#e04a4a" }}>{err}</span> : null}
      </div>
<div className="row">
        <span className="k">pipeline label (T² p)</span>
        <span>
          <Chip state={pipeLabel === "normal" ? "ok" : pipeLabel === "high" ? "err" : pipeLabel === "watch" ? "warn" : null} title="PCA/EWMA Hotelling T² p-value tier of the incoming window">{pipeLabel ?? "—"}</Chip>
          {risk?.pValue != null ? <span className="chip" data-ml-pipe>p {risk.pValue.toFixed(4)}</span> : null}
        </span>
      </div>
      <div className="row">
        <span className="k">log-reg class (tf-lite)</span>
        <span>
          <Chip state={label === "normal" ? "ok" : label === "high" ? "err" : label === "watch" ? "warn" : null}>{label ?? "no score yet"}</Chip>
          <span className={"chip " + (risk?.modelActive === false ? "pending" : risk?.modelActive ? "ok" : "")}>{risk?.modelActive ? "model active" : "model off"}</span>
        </span>
      </div>
      {prob ? (
        <div className="grid grid-cols-3 gap-1.5 mt-1" data-nn-prob>
          {(["normal", "watch", "high"] as const).map((l, i) => {
            const piped = pipeLabel === l;
            const tri = l === "watch" ? "217 164 4" : "var(--pi-" + (l === "normal" ? "ok" : "err") + ")";
            return (
              <div key={l} className="rounded border px-1.5 py-1 text-center select-none" style={{ borderColor: "rgb(" + tri + " / 0.6)", background: "rgb(" + tri + " / 0.10)" }} title={piped ? "matches pipeline label" : undefined}>
                <div className="text-[11px] uppercase tracking-wide leading-none">{l}{piped ? " ◂" : ""}</div>
                <div className="text-[14px] font-semibold tabular-nums leading-tight" style={{ color: "rgb(" + tri + " / 1)" }}>{pc(prob[i] ?? 0)}</div>
              </div>
            );
          })}
          <div className="col-span-3 text-faint text-[11px]">logistic-regression (tf-lite) outcome per class · ◂ card = PCA/EWMA tier</div>
        </div>
      ) : (
        <div className="text-faint text-[12px]">no log-reg inference yet</div>
      )}
      <div className="row"><span className="k">Hotelling T² · p-value</span><span>{risk?.t2 != null ? risk.t2.toFixed(4) : "—"} · {risk?.pValue != null ? risk.pValue.toFixed(5) : "—"}</span></div>
      <div className="row"><span className="k">compute</span><span>{fmtMs(risk?.computeMs)} · logreg {fmtMs(risk?.nnLatencyMs ?? infer?.ms, 1)}</span></div>
      <div className="row"><span className="k">context windows</span><span>{risk?.contextWindows ?? meta?.context?.count ?? 0}/{risk?.contextCap ?? meta?.context?.cap ?? "—"}</span></div>
      <div className="row"><span className="k">windows scored</span><span>{risk?.windowsScored ?? 0}</span></div>
      <div className="row"><span className="k">total variance (PC1–4)</span><span>{risk?.variance?.length ? (totalVar4 * 100).toFixed(1) + "%" : "—"}</span></div>

      {scores.length ? (
        <div className="space-y-0.5" data-pca-bars>
          {scores.map((c) => {
            const z = c.z;
            const color = Math.abs(z) >= high ? "#e04a4a" : Math.abs(z) >= watch ? "#d9a404" : "var(--pi-accent)";
            return (
              <div key={c.i} className="pca-row">
                <span className="pca-lbl">PC{c.i + 1}</span>
                <span className="pca-track">
                  <span className="pca-tick tz" style={{ left: pct(z, 0, scale) + "%" }} />
                  <span className="pca-tick tw" style={{ left: pct(z, -watch, scale) + "%" }} />
                  <span className="pca-tick tw" style={{ left: pct(z, watch, scale) + "%" }} />
                  <span className="pca-tick th" style={{ left: pct(z, -high, scale) + "%" }} />
                  <span className="pca-tick th" style={{ left: pct(z, high, scale) + "%" }} />
                  <span className="pca-marker" style={{ left: pct(z, z, scale) + "%", background: color }} />
                </span>
                <span className="pca-lbl-z" style={{ color }}>z {z.toFixed(2)}</span>
                <span className="pca-dist">{distInfo(z, watch, high)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </Card>
  );
}

// Single source of truth for "best/deployed model" across Live · Training · Config:
// the registered active model's metadata (training.modelMetadata), NOT the last
// run's best trial.
function deployedModelLine(m: ModelMetadata | undefined | null): string {
  if (!m || !m.metrics?.f1) return "—";
  const parts = ["F1 " + m.metrics.f1.toFixed(3)];
  if (m.metrics.accuracy != null) parts.push("acc " + m.metrics.accuracy.toFixed(3));
  if (m.metrics.precision != null) parts.push("P " + m.metrics.precision.toFixed(3));
  if (m.metrics.recall != null) parts.push("R " + m.metrics.recall.toFixed(3));
  if (m.hparams?.kind) parts.push(String(m.hparams.kind).toUpperCase());
  if (m.fineTuned != null) parts.push(m.fineTuned ? "fine-tuned" : "fresh build");
  if (m.datasetRows != null) parts.push("rows " + m.datasetRows);
  return parts.join(" · ");
}

// Watermarks are epoch-ms ints from the backend; always render as est. time.
function fmtWm(v: string | number | null | undefined): string {
  const n = typeof v === "number" ? v : v ? Number(v) : NaN;
  if (!v || !Number.isFinite(n)) return "—";
  if (n > 1e12) return new Date(n).toLocaleString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function LiveCard() {
  const an = useStoreSlice(analyticsStore, (s) => s);
  const meta = an.meta;
  const training = an.training;
  const risk = an.risk;
  const sys = meta?.system;
  const lat = meta?.latency;
  const t2Mini = useMemo(() => an.hist.map((h) => h.t2 ?? null).slice(-24), [an.hist]);
  return (
    <Card cls="ac-sys self-start" title="Live">
      <div className="row"><span className="k">window clock</span><Chip state={risk?.level === "high" ? "err" : risk?.level === "watch" ? "warn" : "ok"}>{risk?.heartbeat ? new Date(risk.heartbeat).toLocaleTimeString() : "—"}</Chip></div>
      <div className="row"><span className="k">ingest</span><Chip state={meta?.ingestEnabled ? "ok" : "warn"}>{meta?.ingestEnabled ? "enabled" : "disabled"}</Chip></div>
      <div className="row"><span className="k">pipeline label</span><Chip state={risk?.level === "high" ? "err" : risk?.level === "watch" ? "warn" : risk?.level ? "ok" : null}>{risk?.level ?? "—"}</Chip></div>
      <div className="row"><span className="k">context windows</span><span>{risk?.contextWindows ?? meta?.context?.count ?? 0}/{risk?.contextCap ?? meta?.context?.cap ?? "—"}</span></div>
      <div className="row"><span className="k">Hotelling T²</span><span className="flex items-center gap-2 min-w-0"><span className="mono">{t2Mini.length ? (t2Mini[t2Mini.length - 1] != null ? t2Mini[t2Mini.length - 1]!.toFixed(2) : "—") : "—"}</span><span className="w-16 shrink-0"><Spark data={t2Mini} color="var(--pi-accent)" height={18} /></span></span></div>
      <div className="row"><span className="k">training</span><span>{training?.state ?? "—"}</span></div>
      <div className="row"><span className="k">telemetry → model</span><Chip state={meta?.model?.active ? "ok" : null}>{meta?.model?.active ? "active" : "off"}</Chip></div>
      <div className="row"><span className="k">deployed model</span><span>{deployedModelLine(training?.modelMetadata)}</span></div>
      <div className="row"><span className="k">config</span><span className="muted">{fmtMs(risk?.computeMs)}</span></div>
      <div className="row"><span className="k">system / ML speed</span><span>{sys ? "cpu " + ((sys.cpuFrac ?? 0) * 100).toFixed(0) + "% · mem " + ((sys.memFrac ?? 0) * 100).toFixed(0) + "%" + (sys.tempC != null ? " · " + sys.tempC.toFixed(1) + "°C" : "") : "—"}{lat?.lastComputeMs != null ? " · compute " + lat.lastComputeMs + "ms" : ""}</span></div>
    </Card>
  );
}

function findNearest(mx: number, my: number): string | null {
  let best: string | null = null;
  let bd = 14;
  for (const o of lastProj) {
    const d = Math.hypot(o.px - mx, o.py - my);
    if (d < bd) { bd = d; best = o.p.windowStart; }
  }
  return best;
}

function draw3d(cv: HTMLCanvasElement, cloud: CloudPoint[], cfg: AnalyticsConfig | null, cam: { yaw: number; pitch: number; zoom: number }, dims: readonly number[], hover: { mx: number; my: number } | null, pin: string | null): void {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300;
  const h = cv.clientHeight || 250;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  setTooltipText("drag to rotate · wheel to zoom · hover to inspect");
  if (!cloud.length) {
    ctx.fillStyle = "rgba(255,255,255,.3)";
    ctx.font = "12px " + cssVar("--font-mono");
    ctx.fillText("no scored windows yet — the cloud builds as windows are scored", 12, 20);
    lastProj = [];
    return;
  }
  const high = Number(cfg?.highZ ?? 1.5);
  const a = dims[0], b = dims[1], c = dims[2];

  const pts = cloud.map((p) => ({ p, x: p.pcs?.[a] ?? 0, y: p.pcs?.[b] ?? 0, z: p.pcs?.[c] ?? 0 }));
  const axis = (d: "x" | "y" | "z") => Math.max(...pts.map((o) => o[d])) - Math.min(...pts.map((o) => o[d]));
  const mid = (d: "x" | "y" | "z") => (Math.min(...pts.map((o) => o[d])) + Math.max(...pts.map((o) => o[d]))) / 2;
  const cx = mid("x"), cy = mid("y"), cz = mid("z");
  const span = Math.max(axis("x"), axis("y"), axis("z"), 1e-6);
  const cosY = Math.cos(cam.yaw), sinY = Math.sin(cam.yaw);
  const cosX = Math.cos(cam.pitch), sinX = Math.sin(cam.pitch);
  const k = (Math.min(w, h) * 0.38 * cam.zoom) / span;
  const proj: ProjPoint[] = pts.map((o) => {
    const x1 = (o.x - cx) * cosY - (o.z - cz) * sinY;
    let z1 = (o.x - cx) * sinY + (o.z - cz) * cosY;
    const y1 = (o.y - cy) * cosX - z1 * sinX;
    const z2 = (o.y - cy) * sinX + z1 * cosX;
    return {
      p: o.p,
      d: z2,
      px: w / 2 + x1 * k,
      py: h / 2 - y1 * k,
      size: Math.abs(o.x),
      mag: Math.hypot(o.x, o.y, o.z),
    };
  });
  proj.sort((p, q) => q.d - p.d);
  lastProj = proj;

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const gx = (w / 8) * i, gy = (h / 8) * i;
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
  }

  let hoverPt: ProjPoint | null = null;
  let hoverDist = 14;
  for (const o of proj) {
    const r = o.p.risk || "normal";
    const zs = o.p.z || [];
    const mag = zs.length ? Math.max(0, ...zs.map(Math.abs)) : typeof o.p.t2 === "number" ? o.p.t2 / 3 : 0;
    const size = Math.max(1.6, Math.min(9, 2 + (o.size / (high * 1.2)) * 3.4));
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = r === "high" ? "#e04a4a" : r === "watch" ? "#d9a404" : viridis(mag / high);
    ctx.beginPath();
    ctx.arc(o.px, o.py, size, 0, Math.PI * 2);
    ctx.fill();
    if (mag >= high) {
      ctx.strokeStyle = "#e04a4a";
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(o.px, o.py, size + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (hover) {
      const d = Math.hypot(o.px - hover.mx, o.py - hover.my);
      if (d < hoverDist) { hoverDist = d; hoverPt = o; }
    }
  }
  if (pin) {
    const s = proj.find((o) => o.p.windowStart === pin);
    if (s) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.px, s.py, s.size + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.font = "10px " + cssVar("--font-mono");
  ctx.fillText("x:PC" + (a + 1) + "  y:PC" + (b + 1) + "  z:depth", 12, h - 10);

  updateTooltip(hoverPt ?? (pin ? proj.find((o) => o.p.windowStart === pin) : null), cloud.length, a + 1, b + 1, !!pin);
}

function updateTooltip(t: ProjPoint | null | undefined, n: number, pa: number, pb: number, pinned: boolean): void {
  if (!t) {
    setTooltipText("n = " + n + " scored windows · PC" + pa + "·PC" + pb + " view" + (pinned ? " · pinned" : ""));
    return;
  }
  const p = t.p;
  const names = p.featureNames || [];
  const zms = (p.z || []).map(Math.abs).filter(Boolean);
  const zmax = zms.length ? Math.max(...zms).toFixed(2) : "—";
  const lines = [
    "n = " + n + " scored windows · PC" + pa + "·PC" + pb + " view" + (pinned ? " · pinned" : ""),
    new Date(p.windowStart).toLocaleString() + "  ·  " + (p.risk || "normal").toUpperCase() +
      "  ·  T² " + (p.t2 != null ? p.t2.toFixed(2) : "—") + "  ·  p " + (p.pValue != null ? p.pValue.toExponential(2) : "—") +
      "  ·  zmax " + zmax +
      "  ·  " + (p.computeMs != null ? p.computeMs.toFixed(1) + "ms" : "") + (p.nnMs != null ? " / logreg " + p.nnMs.toFixed(1) + "ms" : ""),
  ];
  const feats = (p.features || []).map((v, i) => (v != null ? (names[i] || "f" + (i + 1)) + "=" + Number(v).toFixed(2) : null)).filter(Boolean).join("  ");
  const z = (p.z || []).map((v, i) => (v != null ? (names[i] || "f" + (i + 1)) + " z=" + Number(v).toFixed(2) : null)).filter(Boolean).join("  ");
  if (feats) lines.push(feats);
  if (z) lines.push(z);
  setTooltipText(lines.join("\n"));
}

function setTooltipText(s: string): void {
  const el = document.getElementById("mlTooltip");
  if (el) el.textContent = s;
}

function Pca3D() {
  const cloud = useStoreSlice(analyticsStore, (s) => s.cloud);
  const cfg = useStoreSlice(analyticsStore, (s) => s.cfg);
  const visible = usePageVisible();
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<readonly number[]>([0, 1, 2]);
  const [spin, setSpin] = useState(true);
  const [pin, setPin] = useState<string | null>(null);
  const spinRef = useRef(spin);
  spinRef.current = spin;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const dimsRef = useRef(dims);
  dimsRef.current = dims;
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const cam = useRef({ yaw: 0.6, pitch: 0.5, zoom: 1 });

  useFrame(() => {
    const cv = cvRef.current;
    if (!cv) return;
    if (spinRef.current) cam.current.yaw += 0.0016;
    draw3d(cv, cloudRef.current, cfgRef.current, cam.current, dimsRef.current, hover.current, pinRef.current);
  }, visible);

  const hover = useRef<{ mx: number; my: number } | null>(null);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const step = delta > 0 ? 1 / 1.06 : 1.06;
    cam.current.zoom = Math.max(0.15, Math.min(12, cam.current.zoom * step));
  };
  const onMove = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    hover.current = { mx: e.clientX - r.left, my: e.clientY - r.top };
  };
  const onDown = (e: React.MouseEvent) => {
    const cv = cvRef.current;
    if (!cv) return;
    const start = { x: e.clientX, y: e.clientY };
    const cam0 = { ...cam.current };
    const move = (ev: MouseEvent) => {
      cam.current.yaw = cam0.yaw + (ev.clientX - start.x) * 0.011;
      cam.current.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, cam0.pitch + (ev.clientY - start.y) * 0.011));
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const r = cv.getBoundingClientRect();
      setPin(findNearest(ev.clientX - r.left, ev.clientY - r.top));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <Card cls="ac-wh" title="3D PCA explorer">
      <div className="row actions">
        <span className="chip">{dims.map((i) => "PC" + (i + 1)).join("·")}</span>
        <button className="btn-mini" onClick={() => {
          const cur = ML_DIM_SETS.findIndex((s) => s.join() === dims.join());
          setDims(ML_DIM_SETS[(cur + 1) % ML_DIM_SETS.length]);
        }}>Cycle dims</button>
        <button className="btn-mini" onClick={() => setSpin(!spin)}>Rotate: {spin ? "on" : "off"}</button>
        <button className="btn-mini" onClick={() => { cam.current = { yaw: 0.6, pitch: 0.5, zoom: 1 }; setDims([0, 1, 2]); setPin(null); }}>Reset</button>
        <span className="muted ml-auto">drag rotate · scroll zoom (x/y) · hover inspect · click pin</span>
      </div>
      <canvas
        ref={cvRef}
        className="ml-canvas"
        id="pca3d"
        style={{ height: 250 }}
        onWheel={onWheel}
        onMouseMove={onMove}
        onMouseLeave={() => { hover.current = null; }}
        onMouseDown={onDown}
      />
      <div className="pca-legend justify-end mt-1.5">
        <span>last 300 windows (limit=300)</span>
        <span className="divider" />
        <span>low |z|</span>
        <div className="pca-scale" />
        <span>high |z|</span>
        <span className="swatch" style={{ background: "#d9a404", marginLeft: 10 }} />
        <span>watch</span>
        <span className="swatch" style={{ background: "#e04a4a" }} />
        <span>high risk · red halo ≥ high z</span>
        <span className="swatch" style={{ background: "#fff" }} />
        <span>pinned</span>
      </div>
      <div className="muted" style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", marginTop: 4, minHeight: 16, whiteSpace: "pre-wrap" }} id="mlTooltip">
        drag to rotate · wheel to zoom · hover to inspect
      </div>
    </Card>
  );
}

function DriftChart() {
  const hist = useStoreSlice(analyticsStore, (s) => s.hist);
  const cvRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 320, h = cv.clientHeight || 150;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const slice = hist.slice(-20);
    const labelEl = document.getElementById("mlTsLabel");
    if (!slice.length) {
      ctx.fillStyle = "rgba(255,255,255,.3)";
      ctx.font = "12px " + cssVar("--font-mono");
      ctx.fillText("no scored history yet", 12, 20);
      if (labelEl) labelEl.textContent = "Hotelling T² per window — fills as windows are scored";
      return;
    }
    const dr = slice.map((x) => x.drift || 0);
    const mx = Math.max(...dr, 1e-6);
    const bw = w / slice.length;
    slice.forEach((x, i) => {
      const bh = Math.max(1, ((x.drift || 0) / mx) * (h - 22));
      ctx.fillStyle = x.risk === "high" ? "#e04a4a" : x.risk === "watch" ? "#d9a404" : cssVar("--pi-model");
      ctx.fillRect(i * bw + 1, h - 12 - bh, Math.max(2, bw - 2), bh);
    });
    ctx.strokeStyle = "rgba(255,255,255,.15)";
    ctx.beginPath();
    ctx.moveTo(0, h - 12); ctx.lineTo(w, h - 12);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.4)";
    ctx.font = "10px " + cssVar("--font-mono");
    ctx.fillText("max t² " + mx.toFixed(2), 4, 12);
    const lt = slice[slice.length - 1];
    const counts = slice.reduce<Record<string, number>>((o, x) => { o[x.risk || "normal"] = (o[x.risk || "normal"] || 0) + 1; return o; }, {});
    if (labelEl) {
      labelEl.textContent =
        "latest " + (lt?.risk || "?") + " · t² " + (lt?.drift || 0).toFixed(3) + " · " + new Date(lt?.timestamp ?? Date.now()).toLocaleString() +
        " · " + slice.length + " windows · " + (counts.normal || 0) + " normal / " + (counts.watch || 0) + " watch / " + (counts.high || 0) + " high";
    }
  }, [hist]);

  return (
    <Card cls="ac-stream" title="Drift · T² history">
      <canvas ref={cvRef} className="ml-canvas" style={{ height: 150 }} />
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }} id="mlTsLabel">…</div>
    </Card>
  );
}

function qnt(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function boxLabel(n: string): string {
  return BOX_LABELS[n] || shortLabel(n).slice(0, 12);
}

function colorForRisk(r?: string): string {
  return r === "high" ? "#e04a4a" : r === "watch" ? "#d9a404" : cssVar("--pi-ok");
}

function BoxPlots() {
  const cloud = useStoreSlice(analyticsStore, (s) => s.cloud);
  const cvRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 320, h = cv.clientHeight || 220;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!cloud.length) {
      ctx.fillStyle = "rgba(255,255,255,.3)";
      ctx.font = "12px " + cssVar("--font-mono");
      ctx.fillText("no scored windows yet — box plots fill from the PCA cloud", 12, 20);
      return;
    }
    const last = cloud[cloud.length - 1];
    const names = last.featureNames && last.featureNames.length ? last.featureNames : FEAT10;
    const want = [
      ...BOX_FEATURES.filter((f) => names.indexOf(f) >= 0),
      ...(cloud.some((r) => typeof r.t2 === "number") ? ["__t2__"] : []),
    ];
    if (!want.length) {
      ctx.fillStyle = "rgba(255,255,255,.3)";
      ctx.font = "12px " + cssVar("--font-mono");
      ctx.fillText("box-plot features (cpu · mem · temp · tok/s · T²) all disabled in the feature filter", 12, 20);
      return;
    }
    const dim = want.length;
    const slot = w / dim;
    want.forEach((name, i) => {
      const xs = i * slot + slot / 2;
      if (name === "__t2__") {
        const vals = cloud.map((r) => r.t2 == null ? NaN : r.t2).filter(Number.isFinite) as number[];
        if (!vals.length) return;
        const sorted = [...vals].sort((x, y) => x - y);
        const lo = qnt(sorted, 0.02), hi = qnt(sorted, 0.98);
        const q1 = qnt(sorted, 0.25), med = qnt(sorted, 0.5), q3 = qnt(sorted, 0.75);
        const top = h - 22;
        const y = (v: number) => top - ((v - lo) / Math.max(hi - lo, 1e-6)) * (top - 12);
        ctx.strokeStyle = "rgba(255,255,255,.4)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xs - slot / 4, y(q1)); ctx.lineTo(xs + slot / 4, y(q1)); ctx.lineTo(xs + slot / 4, y(q3)); ctx.lineTo(xs - slot / 4, y(q3)); ctx.closePath(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(xs, y(lo)); ctx.lineTo(xs, y(q1)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(xs, y(q3)); ctx.lineTo(xs, y(hi)); ctx.stroke();
        ctx.strokeStyle = "rgba(233,196,106,0.85)";
        ctx.beginPath(); ctx.moveTo(xs - slot / 4, y(med)); ctx.lineTo(xs + slot / 4, y(med)); ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = "10px " + cssVar("--font-mono");
        ctx.textAlign = "center";
        ctx.fillText("T²", xs, h - 4);
        return;
      }
      const idx = names.indexOf(name);
      const vals = cloud
        .map((row) => row.features ? Number(row.features[idx]) : NaN)
        .filter((v) => Number.isFinite(v));
      if (!vals.length) return;
      const sorted = [...vals].sort((x, y) => x - y);
      const lo = qnt(sorted, 0.02), hi = qnt(sorted, 0.98);
      const q1 = qnt(sorted, 0.25), med = qnt(sorted, 0.5), q3 = qnt(sorted, 0.75);
      const top = h - 22;
      const y = (v: number) => top - ((v - lo) / Math.max(hi - lo, 1e-6)) * (top - 12);
      ctx.strokeStyle = "rgba(255,255,255,.4)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xs - slot / 4, y(q1)); ctx.lineTo(xs + slot / 4, y(q1)); ctx.lineTo(xs + slot / 4, y(q3)); ctx.lineTo(xs - slot / 4, y(q3)); ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xs, y(lo)); ctx.lineTo(xs, y(q1)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xs, y(q3)); ctx.lineTo(xs, y(hi)); ctx.stroke();
      ctx.strokeStyle = cssVar("--pi-accent");
      ctx.beginPath(); ctx.moveTo(xs - slot / 4, y(med)); ctx.lineTo(xs + slot / 4, y(med)); ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "10px " + cssVar("--font-mono");
      ctx.textAlign = "center";
      ctx.fillText(boxLabel(name), xs, h - 4);
    });
    const cur = cloud[cloud.length - 1];
    want.forEach((name, i) => {
      const xs = i * slot + slot / 2;
      const top = h - 22;
      const v = name === "__t2__" ? Number(cur.t2) : Number(cur.features?.[[...names].indexOf(name)]);
      if (!Number.isFinite(v)) return;
      const vals = name === "__t2__"
        ? cloud.map((r) => Number(r.t2)).filter(Number.isFinite)
        : cloud.map((row) => Number(row.features?.[[...names].indexOf(name)])).filter(Number.isFinite);
      if (!vals.length) return;
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const y = (vv: number) => top - ((vv - lo) / Math.max(hi - lo, 1e-6)) * (top - 12);
      ctx.fillStyle = colorForRisk(cur.risk);
      ctx.beginPath();
      ctx.arc(xs, y(v), 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [cloud]);

  return (
    <Card cls="ac-host glass" title="Feature z · box plots (glass)">
      <canvas ref={cvRef} className="ml-canvas" style={{ height: 220 }} />
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }} id="mlBoxLabel">current window marked · feature filter + live T² distribution</div>
    </Card>
  );
}

function TelemetrySparks() {
  const hist = useStoreSlice(analyticsStore, (s) => s.hist);
  const latency = useStoreSlice(analyticsStore, (s) => s.latency);
  const runs = useStoreSlice(analyticsStore, (s) => s.runs);
  const t2 = useMemo(() => hist.map((h) => h.t2 ?? null).slice(-60), [hist]);
  const cm = useMemo(() => latency.map((l) => l.computeMs ?? null).slice(-60), [latency]);
  const lr = useMemo(() => latency.map((l) => l.nnMs ?? null).slice(-60), [latency]);
  const f1 = useMemo(() => runs.map((r) => r.metrics?.f1 ?? null).slice(-20), [runs]);
  const rows = useMemo(() => runs.map((r) => r.rows ?? null).slice(-20), [runs]);
  return (
    <Card cls="ac-conn glass" title="Telemetry history">
      <div className="spark-grid">
        <SparkCard label="T²" data={t2} color="var(--pi-accent)" />
        <SparkCard label="compute ms" data={cm} color="var(--pi-pg)" />
        <SparkCard label="logreg ms" data={lr} color="var(--pi-model)" />
        <SparkCard label="model F1" data={f1} color="var(--pi-model)" />
        <SparkCard label="rows" data={rows} color="var(--pi-model)" />
      </div>
    </Card>
  );
}

function SparkCard({ label, data, color }: { label: string; data: (number | null)[]; color: string }) {
  const last = useMemo(() => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i] != null) return data[i];
    return null;
  }, [data]);
  return (
    <div className="spark-item">
      <h3>{label}</h3>
      <div className="mstat">{last == null ? "—" : (last < 10 ? last.toFixed(2) : last.toFixed(1))}</div>
      <Spark data={data} color={color} />
    </div>
  );
}

function TrainingCard() {
  const an = useStoreSlice(analyticsStore, (s) => s);
  const train = an.training;
  const [posting, setPosting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (path: string, id: string) => {
    setPosting(id);
    setErr(null);
    try {
      const res = await api<{ detail?: string }>(path, { method: "POST", body: {} });
      if (res && (res as { detail?: string }).detail) throw new Error((res as { detail?: string }).detail as string);
      if (id === "train" || id === "infer") setTimeout(loadMlPage, 1200);
      appendLog("ml action " + id + " ok", "info");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      appendLog("ml action " + id + " failed: " + msg, "err");
    }
    setPosting(null);
  };
  return (
    <Card cls="ac-pg" title="Training & inference">
      <div className="row">
        <span className="k">state</span>
        <span>
          <Chip state={train?.state === "running" ? "warn" : train?.error ? "err" : train?.modelActive ? "ok" : null}>
            {train?.state === "running" ? "training (run " + (train.run ?? "?") + ")" : train?.error ? "error: " + String(train.error).slice(0, 200) : train?.modelActive ? "model active" : "idle"}
          </Chip>
        </span>
      </div>
      <div className="row"><span className="k">rows / min</span><span>{train?.rows ?? "—"} / {train?.minRows ?? "—"}</span></div>
      <div className="row"><span className="k">run</span><span>{train?.run ?? "—"}</span></div>
      <div className="row"><span className="k">trials · epochs</span><span>{train?.trials ?? "—"} · {train?.epochs ?? "—"}</span></div>
      <div className="row"><span className="k">artifacts</span><span>{train?.tfliteModel ? "tflite " + fmtBytes(train.tfliteBytes ?? 0) : null}{train?.savedModel ? " savedmodel " + fmtBytes(train.modelBytes ?? 0) : null}</span></div>
      <div className="row"><span className="k">watermark · trained up to</span><span>{fmtWm(train?.trainedUpTo)}</span></div>
      <div className="row"><span className="k">model metadata</span><span>{modelMetaBrief(train?.modelMetadata) || "—"}</span></div>
      <div className="row"><span className="k">deployed model</span><span>{deployedModelLine(train?.modelMetadata)}</span></div>
      {an.trials.progress ? (
        <pre className="muted text-[11px] leading-6 whitespace-pre-wrap" data-an-trials>{an.trials.progress}</pre>
      ) : null}
      <div className="row actions mt-1">
        <button className="btn-ghost" disabled={!!posting} onClick={() => void act("/api/analytics/training/start", "train")}>{posting === "train" ? "…" : "Run training"}</button>
        <button className="btn-ghost" disabled={!!posting} onClick={() => void act("/api/analytics/infer", "infer")}>{posting === "infer" ? "…" : "Run log-reg inference (TF-lite)"}</button>
        <button className="btn-ghost" disabled={!!posting} onClick={() => void act("/api/analytics/rebaseline", "rb")}>{posting === "rb" ? "…" : "Rebaseline"}</button>
        <button className="btn-ghost" disabled={!!posting} onClick={() => void loadMlPage()}>Refresh meta</button>
      </div>
      {err ? <div className="muted" style={{ fontSize: 11, marginTop: 6, color: "#e04a4a" }}>{err}</div> : null}
      <div className="overflow-x-auto mt-2">
        <table className="doc" data-ml-runs>
          <thead>
            <tr><th>when</th><th>state</th><th>rows</th><th>epochs</th><th>F1</th><th>acc</th><th>best</th><th>sec</th></tr>
          </thead>
          <tbody>
            {!an.runs.length ? (
              <tr><td colSpan={8} className="muted">no training runs yet — runs appear after the first auto-training</td></tr>
            ) : an.runs.slice(0, 20).map((r, i) => (
              <tr key={r.id ?? "r" + i}>
                <td>{new Date(r.startedAt).toLocaleString()}</td>
                <td><span className={"chip " + (r.error ? "err" : r.state === "done" ? "ok" : "warn")}>{r.state || "—"}</span></td>
                <td className="num">{r.rows ?? "—"}</td>
                <td className="num">{r.epochs ?? "—"}</td>
                <td className="num">{r.metrics?.f1 != null ? r.metrics.f1.toFixed(3) : "—"}</td>
                <td className="num">{r.metrics?.accuracy != null ? r.metrics.accuracy.toFixed(3) : "—"}</td>
                <td>{r.best ? <span className="chip ok">best</span> : "—"}</td>
                <td className="num">{r.seconds != null ? r.seconds.toFixed(1) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function modelMetaBrief(meta?: RegisteredModel["metadata"]): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.hparams?.kind) parts.push(String(meta.hparams.kind).toUpperCase());
  if (meta.architecture?.inputDim != null) parts.push("dim " + meta.architecture.inputDim);
  if (meta.architecture?.params != null) parts.push(Math.round(meta.architecture.params / 1000) + "k");
  if (meta.metrics?.f1 != null) parts.push("F1 " + meta.metrics.f1.toFixed(3));
  if (meta.datasetRows != null) parts.push("rows " + meta.datasetRows);
  if (meta.fineTuned != null) parts.push(meta.fineTuned ? "fine-tuned" : "fresh build");
  if (meta.trainSeconds != null) parts.push(meta.trainSeconds.toFixed(1) + "s train");
  return parts.join(" · ");
}

function ModelsTable() {
  const models = useStoreSlice(analyticsStore, (s) => s.models);
  return (
    <Card cls="ac-wh" title="Registered models">
      <div className="flex items-center justify-between mb-1">
        <span className="chip">{models.length ? models.length + " registered" : "none"}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="doc">
          <thead>
            <tr><th>id</th><th>name</th><th>kind</th><th>enabled</th><th>created</th><th>watermark</th><th>metadata</th></tr>
          </thead>
          <tbody>
            {models.length ? models.map((m) => (
              <tr key={m.id}>
                <td className="num">{m.id}</td>
                <td>{m.name ?? "—"}</td>
                <td>{m.kind ?? "—"}</td>
                <td>{m.enabled ? <span className="chip ok">enabled</span> : <span className="chip">disabled</span>}</td>
                <td>{m.createdAt ? new Date(m.createdAt).toLocaleString() : "—"}</td>
                <td>{m.metadata?.trainedUpTo ? new Date(m.metadata.trainedUpTo).toLocaleString() : "—"}</td>
                <td>{modelMetaBrief(m.metadata) || "—"}</td>
              </tr>
            )) : (
              <tr><td colSpan={7} className="muted">no models registered yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ConfigCard() {
  const cfg = useStoreSlice(analyticsStore, (s) => s.cfg);
  const train = useStoreSlice(analyticsStore, (s) => s.training);
  const features = useStoreSlice(analyticsStore, (s) => s.inputFilter);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{
    ingest: boolean;
    decay?: number;
    pca?: number;
    watch?: number;
    high?: number;
    cron?: string;
    min?: number;
    epochs?: number;
    batch?: number;
    trials?: number;
    val?: number;
    seed?: number;
  }>({ ingest: cfg?.ingestEnabled ?? false });

  useEffect(() => {
    setForm({
      ingest: cfg?.ingestEnabled ?? false,
      decay: cfg?.ewmaDecay,
      pca: cfg?.pcaComponents,
      watch: cfg?.watchZ,
      high: cfg?.highZ,
      cron: cfg?.cron,
      min: cfg?.train?.minRows,
      epochs: cfg?.train?.epochs,
      batch: cfg?.train?.batch,
      trials: cfg?.train?.trials,
      val: cfg?.train?.validation,
      seed: cfg?.train?.seed,
    });
  }, [cfg]);

  async function save() {
    setBusy(true);
    try {
      const patch: AnalyticsConfigPatch = {
        ingestEnabled: form.ingest,
        ewmaDecay: form.decay,
        pcaComponents: form.pca,
        watchZ: form.watch,
        highZ: form.high,
        cron: form.cron || null,
        featureFilter: features.map((f) => f.enabled),
        minRows: form.min,
        epochs: form.epochs,
        batch: form.batch,
        trials: form.trials,
        validation: form.val,
        seed: form.seed,
      };
      const res = await api<AnalyticsConfig>("/api/analytics/config", { method: "PUT", body: patch });
      setCfg(res);
      const m = await api<AnalyticsMeta>("/api/analytics/meta");
      setMeta(m);
    } catch {}
    setBusy(false);
  }

  return (
    <Card cls="ac-wh" title="Config & input filters">
      <details className="cfgbox" open>
        <summary>Model config</summary>
        <div className="cfg-grid">
          <label className="wide col-span-2">deployed best model <input type="text" readOnly value={deployedModelLine(train?.modelMetadata)} /></label>
          <label className="wide">feature window (s) <input type="text" readOnly value={cfg?.featureWindowSec != null ? String(cfg.featureWindowSec) : "—"} /></label>
          <label>ingest <input type="checkbox" checked={form.ingest} onChange={(e) => setForm({ ...form, ingest: e.target.checked })} /></label>
          <label>ewma decay <input type="number" step="0.05" min="0.01" max="0.9" value={form.decay ?? 0.1} onChange={(e) => setForm({ ...form, decay: Number(e.target.value) })} /></label>
          <label>PCA components <input type="number" min="1" max="10" value={form.pca ?? 6} onChange={(e) => setForm({ ...form, pca: Number(e.target.value) })} /></label>
          <label>watch σ <input type="number" step="0.1" min="0.1" value={form.watch ?? 1} onChange={(e) => setForm({ ...form, watch: Number(e.target.value) })} /></label>
          <label>high σ <input type="number" step="0.1" min="0.1" value={form.high ?? 1.5} onChange={(e) => setForm({ ...form, high: Number(e.target.value) })} /></label>
          <label className="wide">cron (5-field UTC) <input type="text" value={form.cron ?? ""} onChange={(e) => setForm({ ...form, cron: e.target.value })} /></label>
          <label className="wide">next run <input type="text" readOnly value={cfg?.nextRun ?? "—"} /></label>
          <label>train: min rows <input type="number" min="10" value={form.min ?? 4000} onChange={(e) => setForm({ ...form, min: Number(e.target.value) })} /></label>
          <label>epochs <input type="number" min="1" value={form.epochs ?? 10} onChange={(e) => setForm({ ...form, epochs: Number(e.target.value) })} /></label>
          <label>batch <input type="number" min="1" value={form.batch ?? 64} onChange={(e) => setForm({ ...form, batch: Number(e.target.value) })} /></label>
          <label>trials <input type="number" min="1" value={form.trials ?? 10} onChange={(e) => setForm({ ...form, trials: Number(e.target.value) })} /></label>
          <label>validation <input type="number" step="0.05" min="0" max="0.5" value={form.val ?? 0.2} onChange={(e) => setForm({ ...form, val: Number(e.target.value) })} /></label>
          <label>seed <input type="number" value={form.seed ?? 7} onChange={(e) => setForm({ ...form, seed: Number(e.target.value) })} /></label>
          <label className="wide">watermark (trainedUpTo · est) <input type="text" readOnly value={fmtWm(cfg?.watermark)} /></label>
        </div>
      </details>
      <div className="feat-head">
        <span>Feature filter</span>
        <span className="muted">{features.filter((f) => f.enabled).length}{features.length ? "/" + features.length : ""} on</span>
      </div>
      <div className="feat-grid">
        {features.map((f) => {
          const on = !!f.enabled;
          return (
            <button
              key={f.name}
              type="button"
              className={"feat-pill" + (on ? " on" : "")}
              onClick={() => {
                analyticsStore.set({ inputFilter: features.map((x) => (x.name === f.name ? { ...x, enabled: !x.enabled } : x)) });
              }}
              title={f.name}
              aria-pressed={on}
            >
              <span className="fv">{shortLabel(f.name)}</span>
              <span className={"fp-dot" + (on ? " on" : "")} />
            </button>
          );
        })}
      </div>
      {features.length === 0 ? <div className="muted" style={{ marginTop: 6 }}>feature filter loads from /api/analytics/meta · refresh</div> : null}
      <div className="row actions mt-2">
        <button className="btn" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save config"}</button>
      </div>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ml-section">
      <h2 className="ml-section-title">{title}</h2>
      {children}
    </section>
  );
}

function BacktestCard() {
  const an = useStoreSlice(analyticsStore, (s) => s);
  const runs = an.backtest;
  const samples = an.backtestSamples;
  const last: BacktestRun | null = runs[0] ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [rlMode, setRlMode] = useState<"p_value" | "z_score">("p_value");
  const [rlW, setRlW] = useState(1.0);
  const [rlZ, setRlZ] = useState(1.5);
  const [rlRetrain, setRlRetrain] = useState(false);

  const act = async (path: string, id: string, body: unknown = {}) => {
    setBusy(id);
    setErr(null);
    setInfo(null);
    try {
      const res = await api<{ ok?: boolean; detail?: string; mode?: string; updated?: number; normal?: number; watch?: number; high?: number }>(path, { method: "POST", body });
      if (res && res.detail) throw new Error(res.detail);
      if (id === "relabel") {
        const mode = (res.mode ?? rlMode).replace("_", " ");
        setInfo("relabeled (" + mode + ") → normal " + (res.normal ?? "?") + " · watch " + (res.watch ?? "?") + " · high " + (res.high ?? "?") + " (" + (res.updated ?? 0) + " windows)");
      } else {
        setInfo("started — run state updates as it completes");
      }
      appendLog("backtest/" + id + " ok", "info");
      void loadBacktest();
      setTimeout(loadMlPage, 2500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      appendLog("backtest/" + id + " failed: " + msg, "err");
    }
    setBusy(null);
  };

  const doRelabel = async () => {
    const body = rlMode === "z_score"
      ? { mode: "z_score", watchZ: rlW, highZ: rlZ, retrain: rlRetrain }
      : { mode: "p_value", retrain: rlRetrain };
    await act("/api/analytics/relabel", "relabel", body);
  };

  const clearWatermark = async () => {
    setBusy("wm");
    setErr(null);
    setInfo(null);
    try {
      await api("/api/analytics/watermark/clear", { method: "POST", body: {} });
      setInfo("training watermark cleared — next training is a full retrain");
      void loadMlPage();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  return (
    <Card cls="ac-backtest self-start" title="Backtest & model verification">
      <div className="space-y-1">
        {last ? (
          <>
            <div className="row"><span className="k">last run</span><span>
              <Chip state={last.state === "done" ? "ok" : last.state === "error" ? "err" : last.state === "running" ? "warn" : null}>{last.state ?? "—"}</Chip>{" "}
              <span className="chip">{last.mode === "train" ? "train & hold-out" : "current model"}</span>
            </span></div>
            <div className="row"><span className="k">when</span><span>{new Date(last.startedAt).toLocaleString()}{last.finishedAt ? " → " + new Date(last.finishedAt).toLocaleTimeString() : ""}</span></div>
            <div className="row"><span className="k">coverage</span><span>{last.windowFrom && last.windowTo ? new Date(last.windowFrom).toLocaleDateString() + " → " + new Date(last.windowTo).toLocaleDateString() : "—"} · {last.rows ?? 0} windows</span></div>
            <div className="row"><span className="k">model watermark</span><span>{last.modelWatermark ? new Date(last.modelWatermark).toLocaleString() : "—"}</span></div>
            <div className="row"><span className="k">agreement</span><span>{last.rows ? (100 * (last.correct ?? 0) / last.rows).toFixed(1) + "% match actual (" + last.correct + "/" + last.rows + ")" : "—"}</span></div>
            <div className="row"><span className="k">metrics</span><span>{last.accuracy != null ? "acc " + last.accuracy.toFixed(3) : "—"} · {last.f1 != null ? "F1 " + last.f1.toFixed(3) : "—"} · {last.precision != null ? "P " + last.precision.toFixed(3) : "—"} · {last.recall != null ? "R " + last.recall.toFixed(3) : "—"}</span></div>
            {last.error ? <div className="row"><span className="k">error</span><span className="muted" style={{ color: "#e04a4a" }}>{last.error}</span></div> : null}
          </>
        ) : <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>no backtest runs yet</div>}
      </div>
      <div className="row actions mt-1 flex-wrap">
        <button className="btn-ghost" disabled={!!busy || an.backtestActive} onClick={() => void act("/api/analytics/backtest", "current", { mode: "current" })}>{busy === "current" ? "…" : an.backtestActive ? "running…" : "Backtest model"}</button>
        <button className="btn-ghost" disabled={!!busy || an.backtestActive} onClick={() => void act("/api/analytics/backtest", "train", { mode: "train" })}>{busy === "train" ? "…" : "Train & backtest"}</button>
        <div className="row actions flex-wrap mt-1">
        <span className="text-[11px] text-dim">relabel as:</span>
        <select
          value={rlMode}
          onChange={(e) => setRlMode(e.target.value as "p_value" | "z_score")}
          className="bg-input border border-border rounded px-1 py-0.5 text-[11px] font-mono"
          title="Label source for the relabel pass"
        >
          <option value="p_value">T² p-value tiers</option>
          <option value="z_score">PCA z-score (σ from mean)</option>
        </select>
        {rlMode === "z_score" ? (
          <>
            <label className="flex items-center gap-1 text-[11px] text-dim">watch σ
              <input type="number" step="0.1" min="0.1" value={rlW} onChange={(e) => setRlW(Number(e.target.value))} className="w-14 bg-input border border-border rounded px-1 py-0.5 font-mono text-[11px]" />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-dim">high σ
              <input type="number" step="0.1" min="0.5" value={rlZ} onChange={(e) => setRlZ(Number(e.target.value))} className="w-14 bg-input border border-border rounded px-1 py-0.5 font-mono text-[11px]" />
            </label>
          </>
        ) : null}
        <label className="flex items-center gap-1 text-[11px] text-dim">
          <input type="checkbox" checked={rlRetrain} onChange={(e) => setRlRetrain(e.target.checked)} /> retrain model after relabel
        </label>
        <button className="btn-mini" disabled={!!busy} onClick={() => void doRelabel()}>{busy === "relabel" ? "…" : "Relabel dataset"}</button>
      </div>
        <button className="btn-mini" disabled={!!busy} onClick={() => void clearWatermark()}>{busy === "wm" ? "…" : "Clear watermark"}</button>
        <button className="btn-mini" disabled={!!busy} onClick={() => void loadBacktest()}>Refresh</button>
      </div>
      {err ? <div className="muted" style={{ fontSize: 11, marginTop: 6, color: "#e04a4a" }}>{err}</div> : null}
      {info ? <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{info}</div> : null}
      <div className="overflow-x-auto mt-2">
        <table className="doc" data-ml-backtest>
          <thead>
            <tr><th>when</th><th>actual</th><th>log-reg</th><th>normal</th><th>watch</th><th>high</th><th></th></tr>
          </thead>
          <tbody>
            {!samples.length ? (
              <tr><td colSpan={7} className="muted">no samples — run a backtest to populate the dataset</td></tr>
            ) : samples.slice(0, 60).map((s, i) => (
              <tr key={i}>
                <td>{new Date(s.windowStart).toLocaleString()}</td>
                <td>{s.actual ?? "—"}</td>
                <td><span className={"chip " + (s.nnRisk === "normal" ? "ok" : s.nnRisk === "high" ? "err" : s.nnRisk === "watch" ? "warn" : "")}>{s.nnRisk ?? "—"}</span></td>
                {(["normal", "watch", "high"] as const).map((l, j) => (
                  <td className="num" key={l}>{s.nnProb && s.nnProb[j] != null ? (s.nnProb[j] * 100).toFixed(0) + "%" : "—"}</td>
                ))}
                <td>{s.match ? <span className="chip ok">✓</span> : <span className="chip">✗</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PipeFlowDocs() {
  const { risk, meta } = useStoreSlice(analyticsStore, (s) => ({ risk: s.risk, meta: s.meta }));
  return (
    <Card cls="ac-wh" title="Analytics docs & pipeline flow">
      <div className="pipe-flow">
        <div className="pipe-step"><b>telemetry</b>gateway → /v1/analytics/ingest</div><span className="pipe-arrow">→</span>
        <div className="pipe-step"><b>window</b>10 masked features</div><span className="pipe-arrow">→</span>
        <div className="pipe-step"><b>EWMA ref</b>adaptive μ · σ</div><span className="pipe-arrow">→</span>
        <div className="pipe-step"><b>PCA + T²</b>z → pcz · χ² p-value</div><span className="pipe-arrow">→</span>
        <div className="pipe-step"><b>label</b>T² p tier ≥ 0.10/0.05</div><span className="pipe-arrow">→</span>
        <div className="pipe-step"><b>risk</b>sse stream · ws → ui</div>
      </div>
      <div className="pipe-note">context windows: <span className="mono" data-ml-ctx>{risk?.contextWindows ?? meta?.context?.count ?? 0}/{risk?.contextCap ?? meta?.context?.cap ?? "—"}</span> — EWMA/PCA sample buffer (cap = <span className="mono">ANALYTICS_CONTEXT_WINDOWS</span>); every ingested window is scored into it and written to SQLite as the stored label.</div>
      <div className="pipe-feed">
        <div className="pipe-flow">
          <div className="pipe-step"><b>warehouse</b>windows · requests · reference</div><span className="pipe-arrow">→</span>
          <div className="pipe-step"><b>dataset</b>raw masked X · risk y</div><span className="pipe-arrow">→</span>
          <div className="pipe-step"><b>train</b>random-search MLR/MLP</div><span className="pipe-arrow">→</span>
          <div className="pipe-step"><b>fine-tune</b>since watermark</div><span className="pipe-arrow">→</span>
          <div className="pipe-step"><b>export</b>savedmodel → risk.tflite</div>
        </div>
        <div className="pipe-note">TFLite model classifies each scored window's raw masked vector → <span className="mono">nnRisk</span> (fed back to the scorecard, not into training labels).</div>
      </div>
      <div className="pipe-note">Docs: <a href="#" onClick={(e) => { e.preventDefault(); setView("documents"); }}>Documents → analytics layer · API surface</a> · repo file <span className="mono">docs/analytics-layer.md</span> §5 risk, §7 API, §8 training data, §9 artifacts.</div>
    </Card>
  );
}

export function ML() {
  useEffect(() => {
    void loadMlPage();
    void loadLatency();
    const id = window.setInterval(() => {
      void loadMlPage();
      void loadLatency();
      void loadBacktest();
    }, 5000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="grid gap-4 grid-cols-1">
      <Section title="Live log-reg scoring · drift & box plots">
        <LogRegScorecard />
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 mt-4">
          <div className="grid gap-4 content-start">
            <LiveCard />
            <DriftChart />
            <TelemetrySparks />
          </div>
          <BoxPlots />
        </div>
      </Section>

      <Section title="PCA cloud">
        <Pca3D />
      </Section>

      <Section title="Training & backtesting">
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
          <TrainingCard />
          <BacktestCard />
        </div>
      </Section>

      <Section title="Registered models">
        <ModelsTable />
      </Section>

      <Section title="Docs & pipeline">
        <PipeFlowDocs />
      </Section>

      <Section title="Filters & runtime">
        <ConfigCard />
      </Section>
    </div>
  );
}