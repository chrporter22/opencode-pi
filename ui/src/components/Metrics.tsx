import { useStoreSlice } from "../store/core";
import { statusStore } from "../store/status";
import { analyticsStore } from "../store/analytics";
import { Card } from "./ui";
import { Spark } from "./Spark";
import { NeoFetch } from "./Neo";

export function Metrics() {
  const hist = useStoreSlice(statusStore, (s) => s.hist);
  const sys = useStoreSlice(statusStore, (s) => s.sys);
  const an = useStoreSlice(analyticsStore, (s) => s);

  const t2Hist = an.hist
    .map((h) => h.t2 ?? null)
    .filter((v): v is number => v != null)
    .slice(-60);
  const computeHist = an.latency.map((l) => l.computeMs ?? null);
  const nnHist = an.latency.map((l) => l.nnMs ?? null);
  const f1Hist = an.runs.map((r) => r.metrics?.f1 ?? null);
  const rowsHist = an.runs.map((r) => r.rows ?? null);

  return (
    <div className="grid gap-4 grid-cols-1">
      <Card cls="ac-stream" title="Live metrics">
        <div className="spark-grid">
          <SparkItem label="CPU" value={sys?.cpu} data={hist.cpu ?? []} color="var(--pi-accent)" max={100} />
          <SparkItem label="Memory" value={sys?.memory} data={hist.mem ?? []} color="var(--pi-accent)" max={100} />
          <SparkItem label="Temperature" value={sys?.temperature} data={hist.temp ?? []} color="var(--pi-host)" />
          <SparkItem label="API calls/min" value={sys?.requestsPerMinute} data={hist.rqm ?? []} color="var(--pi-stream)" />
          <SparkItem label="tok/s" value={sys?.tokensPerSecond} data={hist.tps ?? []} color="var(--pi-model)" />
        </div>
        <div className="spark-grid">
          <SparkItem label="T²" value={lastVal(t2Hist)} data={t2Hist} color="var(--pi-accent)" />
          <SparkItem label="compute ms" value={lastVal(computeHist)} data={computeHist} color="var(--pi-pg)" />
          <SparkItem label="logreg ms" value={lastVal(nnHist)} data={nnHist} color="var(--pi-model)" />
          <SparkItem label="ctx windows" value={lastVal(an.ctxHist)} data={an.ctxHist} color="var(--pi-stream)" max={an.risk?.contextCap ?? 12} />
          <SparkItem label="model F1" value={numb(lastVal(f1Hist)) ? lastVal(f1Hist) : null} data={f1Hist} color="var(--pi-model)" />
          <SparkItem label="rows" value={numb(lastVal(rowsHist)) ? lastVal(rowsHist) : null} data={rowsHist} color="var(--pi-model)" />
        </div>
      </Card>
      <Card cls="ac-host" title="Host & runtime">
        <NeoFetch />
      </Card>
    </div>
  );
}

function numb(v: number | null): v is number {
  return v != null;
}

function lastVal(a: (number | null)[]): number | null {
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] != null) return a[i];
  }
  return null;
}

function SparkItem({ label, value, data, color, max }: { label: string; value?: number | null; data: (number | null)[]; color: string; max?: number }) {
  return (
    <div className="spark-item">
      <h3>{label}</h3>
      <div className="mstat">{fmtVal(value)}</div>
      <Spark data={data} color={color} max={max} />
    </div>
  );
}

function fmtVal(v?: number | null): string {
  if (v == null) return "—";
  return v.toFixed(v < 10 ? 2 : 1);
}