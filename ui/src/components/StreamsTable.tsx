import { useState } from "react";
import { useStoreSlice } from "../store/core";
import { opsStore } from "../store/ops";
import type { RequestRecord } from "../types";

export function StreamsTable({ limit = 20 }: { limit?: number }) {
  const requests = useStoreSlice(opsStore, (s) => s.requests);
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = [...requests].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  const active = rows.filter((r) => r.status === "started").length;

  return (
    <div>
      <div className="row actions">
        <span className="muted">{active > 0 ? active + " active" : "0 active"}</span>
      </div>
      {rows.length === 0 ? (
        <div className="muted py-2">No inference requests yet.</div>
      ) : (
        <div className="table-scroll overflow-x-auto">
          <table className="streams">
            <thead>
              <tr>
                <th>Time</th>
                <th>Request</th>
                <th>Status</th>
                <th>Source</th>
                <th>Tokens P/C/T</th>
                <th>tok/s</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.id} r={r} expanded={expanded === r.id} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ r, expanded, onToggle }: { r: RequestRecord; expanded: boolean; onToggle: () => void }) {
  const stCls = r.status === "completed" ? "chip ok" : r.status === "error" ? "chip err" : "chip warn";
  return (
    <>
      <tr onClick={onToggle}>
        <td>{new Date(r.startedAt).toLocaleTimeString()}</td>
        <td title={(r.id ?? "") + (r.path ? " · " + r.path : "")}>{short(r.id)}</td>
        <td>
          <span
            className={r.status === "error" ? stCls + " clk" : stCls}
            title={r.status === "error" ? String(r.error ?? "") : undefined}
          >
            {r.status ?? "—"}
          </span>
        </td>
        <td>{r.source ?? "—"}
          {r.ip && r.ip !== "?" ? <span className="dim"> {r.ip}</span> : null}
        </td>
        <td className={"num" + (r.totalTokens == null ? " dim" : "")}>
          {[r.promptTokens ?? "—", r.completionTokens ?? "—", r.totalTokens ?? "—"].join("/")}
        </td>
        <td className={"num" + (r.tokensPerSecond == null ? " dim" : " " + tpsColor(r.tokensPerSecond))}>
          {r.tokensPerSecond != null ? r.tokensPerSecond.toFixed(1) : "—"}
        </td>
        <td className="num">{r.durationMs != null ? r.durationMs + " ms" : "—"}</td>
      </tr>
      {expanded && r.status === "error" ? (
        <tr className="errDetail">
          <td colSpan={7}>reason: {r.error ?? "—"}</td>
        </tr>
      ) : null}
    </>
  );
}

function short(s?: string | null): string {
  return s ? s.slice(0, 8) : "—";
}

function tpsColor(v?: number | null): string {
  if (v == null) return "";
  if (v < 1) return "t1";
  if (v < 2) return "t2";
  if (v < 4) return "t3";
  return "t4";
}