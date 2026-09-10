import { useState } from "react";
import { api } from "../lib/api";
import type { QueryResult, WarehouseRedis, WarehouseSql } from "../types";
import { fmtBytes } from "../lib/fmt";
import { Card, Chip } from "./ui";

const SQL_PRESETS = [
  { label: "windows recent", sql: "SELECT id, window_start, risk, t2, p_value, compute_ms FROM windows ORDER BY window_start DESC LIMIT 20;" },
  { label: "windows + features", sql: "SELECT id, window_start, feature_vec, risk FROM windows ORDER BY window_start DESC LIMIT 10;" },
  { label: "requests", sql: "SELECT id, started_at, feature_vec, error FROM requests ORDER BY started_at DESC LIMIT 20;" },
  { label: "training runs", sql: "SELECT id, started_at, state, rows, epochs, best, model_file FROM training_runs ORDER BY id DESC LIMIT 10;" },
  { label: "models", sql: "SELECT * FROM models;" },
  { label: "reference", sql: "SELECT id, updated_at, mu, s2, n FROM reference;" },
  { label: "config", sql: "SELECT id, updated_at, doc FROM config;" },
  { label: "schema: windows", sql: "PRAGMA table_info(windows);" },
];

export function Warehouse() {
  const [sql, setSql] = useState("");
  const [res, setRes] = useState<QueryResult | null>(null);
  const [status, setStatus] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [wh, setWh] = useState<WarehouseSql | null>(null);
  const [redis, setRedis] = useState<WarehouseRedis | null>(null);
  const [rawKind, setRawKind] = useState<"windows" | "requests">("windows");
  const [rawLimit, setRawLimit] = useState(25);
  const [raw, setRaw] = useState<QueryResult | null>(null);
  const [rawStatus, setRawStatus] = useState("");
  const [blocked, setBlocked] = useState(false);

  async function runSql(s: string) {
    if (!s.trim()) return;
    setRunning(true);
    setStatus("running…");
    try {
      const body = await api<QueryResult>("/api/analytics/warehouse/query", { method: "POST", body: { sql: s } });
      setRes(body);
      setStatus("ok · " + (body.rowCount ?? (body.rows ?? []).length) + " rows in " + (body.ms ?? "—") + "ms");
    } catch (e) {
      setStatus("error: " + (e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function loadWarehouse() {
    setBlocked(true);
    try {
      const [w, r] = await Promise.all([
        api<WarehouseSql>("/api/analytics/warehouse/sql").catch(() => null),
        api<WarehouseRedis>("/api/analytics/warehouse/redis").catch(() => null),
      ]);
      if (w) setWh(w);
      if (r) setRedis(r);
    } finally {
      setBlocked(false);
    }
  }

  async function loadRaw(kind: typeof rawKind, limit: number) {
    setBlocked(true);
    setRawKind(kind);
    try {
      const body = (await api<unknown[]>("/api/analytics/warehouse/raw/" + kind + "?limit=" + limit)) as Record<string, unknown>[];
      const cols = kind === "windows"
        ? ["id", "windowStart", "features", "z", "risk", "t2", "pValue", "computeMs", "createdAt"]
        : ["id", "startedAt", "features", "status"];
      const rows = body.map((rec) => kind === "windows"
        ? [String(rec.id), fmtDT(rec.windowStart),
          fmtFeats(rec.features as unknown[], rec.featureNames as string[] | undefined, false),
          fmtFeats(rec.z as unknown[], rec.featureNames as string[] | undefined, true),
          rec.risk,
          numOr(rec.t2), numOr(rec.pValue, 4),
          rec.computeMs != null ? Number(rec.computeMs).toFixed(1) + "ms" : null,
          fmtDT(rec.createdAt)]
        : [String(rec.id), fmtDT(rec.startedAt),
          fmtFeats(rec.features as unknown[], rec.featureNames as string[] | undefined, false),
          rec.error ? "error" : "ok"]);
      setRaw({ columns: cols, rows, rowCount: rows.length, truncated: false });
      setRawStatus(rows.length + " raw rows");
    } catch (e) {
      setRawStatus("failed: " + (e as Error).message);
    } finally {
      setBlocked(false);
    }
  }

  return (
    <div className="grid gap-4 grid-cols-1">
      <Card cls="ac-wh" title="Warehouse connections">
        <div className="row"><span className="k">engine</span><span>sqlite · analytics:8081</span></div>
        <div className="row"><span className="k">db</span><span>{wh?.path ?? (blocked ? "loading…" : "—")}</span></div>
        <div className="row"><span className="k">tables</span><span className="text-[11.5px] whitespace-normal">{(wh?.tables ?? []).map((t) => t.table + " ×" + t.rows).join("  ") || "—"}</span></div>
        <div className="row"><span className="k">windows / requests</span><span>{(wh?.windows ?? 0) + " / " + (wh?.requests ?? 0)}</span></div>
        <div className="row"><span className="k">redis</span>
          <span>
            <Chip state={redis ? (redis.available !== false ? "ok" : "err") : null}>{redis ? (redis.available !== false ? "available" : "n/a") : "—"}</Chip>
            {redis?.memoryBytes != null ? <span className="chip">{fmtBytes(redis.memoryBytes)}</span> : null}
            {redis?.persistence != null ? <span className="chip">{redis.persistence ? "aof" : "no-aof"}</span> : null}
          </span>
        </div>
        <div className="row actions mt-1">
          <button className="btn-ghost" disabled={blocked} onClick={() => { void loadWarehouse(); }}>Refresh</button>
          <button className="btn-ghost" disabled={blocked} onClick={() => { void loadRaw(rawKind, rawLimit); }}>Load raw history</button>
        </div>
      </Card>

      <Card cls="ac-wh" title="SQL console">
        <div className="row"><span className="k">tables</span><span className="muted">windows · requests · reference · training_runs · config · models</span></div>
        <div className="filter-bar">
          {SQL_PRESETS.map((p) => (
            <button key={p.label} onClick={() => { setSql(p.sql); void runSql(p.sql); }}>{p.label}</button>
          ))}
        </div>
        <textarea
          className="pnote"
          style={{ minHeight: 66 }}
          spellCheck={false}
          placeholder="SELECT …"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
        />
        <div className="row actions" style={{ marginTop: 6 }}>
          <button className="btn" disabled={running} onClick={() => { void runSql(sql); }}>Run SQL</button>
        </div>
        <div className="muted" style={{ margin: "6px 0 4px" }}>{status}</div>
        <ResultTable res={res} />
      </Card>

      <Card cls="ac-wh" title="Raw historical data">
        <div className="row actions">
          <span className="chip">{rawKind}</span>
          <select
            className="bg-input border border-border rounded px-1 py-0.5 text-[12px]"
            value={rawLimit}
            onChange={(e) => {
              const l = Number(e.target.value);
              setRawLimit(l);
              void loadRaw(rawKind, l);
            }}
          >
            {[10, 25, 50].map((n) => <option key={n} value={n}>{n} rows</option>)}
          </select>
          <button className="btn-mini" disabled={blocked} onClick={() => { void loadRaw("windows", rawLimit); }}>windows</button>
          <button className="btn-mini" disabled={blocked} onClick={() => { void loadRaw("requests", rawLimit); }}>requests</button>
        </div>
        <div className="muted" style={{ margin: "2px 0 4px" }}>{rawStatus}</div>
        <ResultTable res={raw} />
      </Card>
    </div>
  );
}

function fmtFeats(feats: unknown[] | undefined, names: string[] | undefined, z: boolean): string {
  if (!feats || !feats.length) return "—";
  const n = z ? "z" : "";
  return feats
    .map((v, i) => (names && names[i] ? names[i] : "f" + (i + 1)) + n + "=" + (typeof v === "number" ? v.toFixed(3) : String(v)))
    .join(" ");
}

function fmtDT(v: unknown): string {
  if (v == null) return "—";
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

function numOr(v: unknown, digits = 3): string | null {
  if (v == null) return null;
  return Number(v).toFixed(digits);
}

function ResultTable({ res }: { res: QueryResult | null }) {
  if (!res) return <div className="muted">no result</div>;
  const cols = res.columns ?? [];
  if (!cols.length) return <div className="muted">executed ({res.rowCount})</div>;
  return (
    <div className="overflow-x-auto">
      <table className="doc">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {(res.rows ?? []).map((r, i) => (
            <tr key={i}>
              {cols.map((_, j) => (
                <td key={j}>{Cell(String(r[j] ?? ""))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted" style={{ marginTop: 4 }}>
        {res.rowCount} row{res.rowCount === 1 ? "" : "s"}{res.truncated ? " (truncated to 200)" : ""}
      </div>
    </div>
  );
}

function Cell(s: string): React.ReactNode {
  if (s === "") return <span className="muted">NULL</span>;
  const esc = s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c],
  );
  return <span className="mono text-[11px]">{esc.length > 140 ? esc.slice(0, 140) + "…" : esc}</span>;
}