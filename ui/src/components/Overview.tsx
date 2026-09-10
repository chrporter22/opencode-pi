import { useMemo, useState } from "react";
import { useStoreSlice } from "../store/core";
import { statusStore } from "../store/status";
import { opsStore } from "../store/ops";
import { analyticsStore } from "../store/analytics";
import { setView } from "../store/ui";
import { syncAll } from "../lib/checks";
import { api } from "../lib/api";
import { fmtBytes } from "../lib/fmt";
import { Card, Chip, Row } from "./ui";
import { Spark } from "./Spark";
import { LogRegCard } from "./LogRegCard";
import { StreamsTable } from "./StreamsTable";

function SystemCard() {
  const { sys, hist } = useStoreSlice(statusStore, (s) => ({ sys: s.sys, hist: s.hist }));
  return (
    <Card cls="ac-sys" title="System">
      <table className="stats">
        <tbody>
          <tr><td className="k">CPU</td><td className="num">{sys?.cpu != null ? sys.cpu.toFixed(0) + "%" : "—"}</td></tr>
          <tr><td className="k">Memory</td><td className="num">{sys?.memory != null ? sys.memory.toFixed(0) + "%" : "—"}</td></tr>
          <tr><td className="k">Temperature</td><td className="num">{sys?.temperature != null ? sys.temperature.toFixed(1) + "°C" : "—"}</td></tr>
          <tr><td className="k">Disk used</td><td className="num">{sys?.disk?.usedPercent != null ? sys.disk.usedPercent.toFixed(0) + "%" : sys?.diskUsedPct != null ? sys.diskUsedPct.toFixed(0) + "%" : "—"}</td></tr>
          <tr><td className="k">API calls/min</td><td className="num">{sys?.requestsPerMinute != null ? sys.requestsPerMinute.toFixed(1) : "—"}</td></tr>
          <tr><td className="k">Token rate</td><td className="num">{sys?.tokensPerSecond != null ? sys.tokensPerSecond.toFixed(1) + " t/s" : "—"}</td></tr>
        </tbody>
      </table>
      <div className="spark-grid mt-2">
        <SparkItem label="cpu" data={hist.cpu ?? []} color="var(--pi-accent)" sparkMax={100} />
        <SparkItem label="mem" data={hist.mem ?? []} color="var(--pi-model)" sparkMax={100} />
        <SparkItem label="temp" data={hist.temp ?? []} color="var(--pi-err)" />
      </div>
    </Card>
  );
}

function SparkItem({ label, data, color, sparkMax }: { label: string; data: (number | null)[]; color: string; sparkMax?: number }) {
  return (
    <div className="spark-item">
      <h3>{label}</h3>
      <Spark data={data} color={color} max={sparkMax} />
    </div>
  );
}

function ModelCard() {
  const meta = useStoreSlice(statusStore, (s) => s.meta);
  const status = useStoreSlice(statusStore, (s) => s.status);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Card cls="ac-model full" title="Model">
      <Row k="name" v={meta?.name ?? "—"} />
      <Row k="quantization" v={meta?.quantization ?? "—"} />
      <Row k="context window" v={meta?.contextSize ?? "—"} />
      <Row k="gateway" v={<Chip state={status?.gateway === "online" ? "ok" : "err"}>{status?.gateway ?? "…"}</Chip>} />
      <Row k="llama" v={<Chip state={status?.llama === "ready" || status?.llama === "online" ? "ok" : "err"}>{status?.llama ?? "…"}</Chip>} />
      <Row k="model loaded" v={<Chip state={status?.modelLoaded ? "ok" : "err"}>{String(status?.modelLoaded ?? "…")}</Chip>} />
      <Row k="installed" v={String(meta?.installed ?? "—")} />
      <Row k="size" v={fmtBytes(meta?.sizeBytes)} />
      <Row k="installed at" v={meta?.installedAt ?? "—"} />
      {meta?.loadingStatus ? <Row k="status" v={meta.loadingStatus} /> : null}
      <div className="row actions mt-2">
        <button
          className="btn-ghost"
          disabled={!!!localStorage.getItem("adminKey") || busy !== null}
          onClick={async () => {
            setBusy("restart");
            try {
              await api("/api/model/restart", { method: "POST" });
            } catch {}
            setBusy(null);
          }}
        >
          {busy === "restart" ? "restarting…" : "Restart model"}
        </button>
        <button
          className="btn-ghost"
          disabled={!!!localStorage.getItem("adminKey") || busy !== null}
          onClick={async () => {
            setBusy("update");
            try {
              await api("/api/model/update", { method: "POST" });
            } catch {}
            setBusy(null);
          }}
        >
          {busy === "update" ? "updating…" : "Update model"}
        </button>
      </div>
    </Card>
  );
}

function AnalyticsMiniCard() {
  const risk = useStoreSlice(analyticsStore, (s) => s.risk);
  const infer = useStoreSlice(analyticsStore, (s) => s.infer);
  const label = infer?.label ?? risk?.nnRisk ?? risk?.level ?? null;
  const prob = infer?.prob ?? (risk?.nnProb as number[] | undefined) ?? null;
  return (
    <Card cls="ac-wh full" title="Analytics">
      <div className="row">
        <span className="k">log-reg class (tf-lite)</span>
        <span>
          <Chip state={label === "normal" ? "ok" : label === "high" ? "err" : label === "watch" ? "warn" : null}>{label ?? "—"}</Chip>
          {infer?.ms != null ? <span className="chip ml-1">{infer.ms} ms</span> : null}
        </span>
      </div>
      {prob && prob.length === 3 ? (
        <div className="space-y-1 mt-1">
          {(["normal", "watch", "high"] as const).map((l, i) => (
            <div key={l} className="row">
              <span className="k w-[52px]">{l}</span>
              <div className="h-2 flex-1 rounded bg-input">
                <div className="h-2 rounded transition-[width] duration-500" style={{ width: (prob[i] * 100).toFixed(0) + "%", background: l === "normal" ? "var(--pi-ok)" : l === "high" ? "var(--pi-err)" : "#fde725" }} />
              </div>
              <span className="num text-[11px]">{(prob[i] * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="row"><span className="k">Hotelling T² · p</span><span>{risk?.t2 != null ? risk.t2.toExponential(2) : "—"} · {risk?.pValue != null ? risk.pValue.toExponential(2) : "—"}</span></div>
      <div className="row"><span className="k">compute ms</span><span>{risk?.computeMs ?? "—"}</span></div>
      <div className="row"><span className="k">windows scored</span><span>{risk?.windowsScored ?? "—"}</span></div>
      <div className="row actions mt-1">
        <button className="btn-mini" onClick={() => setView("ml")}>Open ML Analytics</button>
      </div>
    </Card>
  );
}

function QuickSync() {
  const sync = useStoreSlice(opsStore, (s) => s.sync);
  const [running, setRunning] = useState(false);
  const last = sync.length ? sync[sync.length - 1] : null;
  return (
    <Card cls="ac-conn span2" title="Quick sync">
      <div className="row actions">
        <button className="btn" disabled={running} onClick={async () => {
          setRunning(true);
          try {
            await syncAll();
          } finally {
            setRunning(false);
          }
        }}>
          {running ? "Running…" : "Run quick sync"}
        </button>
        <span className="muted">{last ? "last sync " + new Date(last.when).toLocaleTimeString() : "not run yet"}</span>
      </div>
      <div className="muted" style={{ margin: "6px 0 4px" }}>Tests every connection and pipeline reachable from the gateway.</div>
      <div>
        {sync.slice(-12).map((r, i) => (
          <div key={i} className={"sync-item " + r.status}>
            <span className="s-name">{r.name}</span>
            <span className="s-kind">{r.kind}</span>
            <span className="s-note">{r.note}</span>
            <span className="s-lat">{r.latMs != null ? r.latMs + " ms" : ""}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function LiveActivity() {
  const logs = useStoreSlice(opsStore, (s) => s.logs);
  const recent = useMemo(() => logs.slice(-120), [logs]);
  return (
    <Card cls="ac-evt full" title="Live activity" id="live-activity">
      <div className="log" data-live="activity">
        {recent.map((e, i) => (
          <div key={i} className="evt">
            <span className="t">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={"tag " + colourLevel(e.level)}>{e.level}</span>
            <span className="msg">{e.msg}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function colourLevel(l: string): string {
  if (l === "error") return "err";
  if (l === "warn") return "warn";
  return "info";
}

export function Overview() {
  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-3 flex-1">
      <QuickSync />
      <SystemCard />
      <ModelCard />
      <AnalyticsMiniCard />
      <LogRegCard key="logreg-full" />
      <div className="lg:col-span-2 lg:row-span-2">
        <Card cls="ac-stream" title="Client request streams" id="stream-card">
          <StreamsTable />
        </Card>
      </div>
      <LiveActivity />
    </div>
  );
}