import { useStoreSlice } from "../store/core";
import { statusStore } from "../store/status";
import { opsStore } from "../store/ops";
import { analyticsStore } from "../store/analytics";
import { CHECKS, syncConnection } from "../lib/checks";
import { fmtBytes, fmtUptime } from "../lib/fmt";
import { Card, Row } from "./ui";
import { NeoFetch } from "./Neo";

function CheckCard({ id }: { id: string }) {
  const def = CHECKS.find((c) => c.id === id)!;
  const sync = useStoreSlice(opsStore, (s) => [...s.sync].reverse().find((x) => x.name === def.name));
  return (
    <Card cls={acCls(id)} title={titleFor(id, def)}>
      <Row
        k="status"
        v={
          <span className="flex items-center gap-2">
            <span className={"chip " + (sync?.status === "ok" ? "ok" : sync?.status === "err" ? "err" : sync?.status === "warn" ? "warn" : "pending")}>
              {sync ? (sync.status === "ok" ? "ok" : sync.status === "err" ? "failed" : "no key") : "—"}
            </span>
            <button
              className="btn-mini"
              onClick={() => {
                void syncConnection(id);
              }}
            >
              sync
            </button>
          </span>
        }
      />
      <Row k="note" v={sync?.note ?? "not run yet"} />
      <Row k="latency" v={sync?.latMs != null ? sync.latMs + " ms" : "—"} />
      <Row k="last sync" v={sync ? new Date(sync.when).toLocaleTimeString() : "—"} />
    </Card>
  );
}

function acCls(id: string): string {
  if (id === "gw" || id === "llama") return "ac-conn";
  if (id === "sys") return "ac-sys";
  if (id === "model" || id === "oc" || id === "mlm") return "ac-model";
  if (id === "logs" || id === "p_inf" || id === "p_up" || id === "p_str") return "ac-evt";
  if (id.startsWith("wh")) return "ac-wh";
  return "ac-pg";
}

function titleFor(id: string, def: { name: string }): string {
  if (id === "p_inf") return "llama inference · /v1/chat/completions";
  if (id === "p_up") return "model update · download → verify → swap";
  if (id === "p_str") return "request streams";
  return def.name;
}

function HostCard() {
  const host = useStoreSlice(statusStore, (s) => s.host);
  const sys = useStoreSlice(statusStore, (s) => s.sys);
  return (
    <Card cls="ac-host" title="Host">
      <NeoFetch />
      <div className="mt-2">
        <Row k="filesystem" v={host?.mounts?.map((m) => m.device + " @ " + m.mount).join("  ·  ") || "—"} />
        <Row k="disk used" v={sys?.disk?.usedPercent != null ? sys.disk.usedPercent.toFixed(0) + "%" : "—"} />
        <Row k="disk available" v={fmtBytes(sys?.disk?.availableBytes)} />
        <Row k="uptime" v={fmtUptime(host?.uptimeSeconds)} />
      </div>
    </Card>
  );
}

function StorageCards() {
  const sys = useStoreSlice(statusStore, (s) => s.sys);
  const st = useStoreSlice(statusStore, (s) => s.meta);
  const an = useStoreSlice(analyticsStore, (s) => s);
  const disk = sys?.disk;
  const pct = disk?.usedPercent ?? sys?.diskUsedPct;
  return (
    <>
      <Card title="Disk">
        <div className="usage-bar"><div style={{ width: (pct ?? 0) + "%" }} /></div>
        <Row k="used" v={pct != null ? pct.toFixed(0) + "%" : "—"} />
        <Row k="available" v={fmtBytes(disk?.availableBytes)} />
      </Card>
      <Card cls="ac-model" title="Model file">
        <Row k="file" v={st?.file ?? "—"} />
        <Row k="quantization" v={st?.quantization ?? "—"} />
        <Row k="size" v={fmtBytes(st?.sizeBytes)} />
        <Row k="installed at" v={st?.installedAt ?? "—"} />
        <Row k="sha-256" v={st?.sha256 ?? "—"} />
      </Card>
      <Card cls="ac-wh" title="Storage paths">
        <Row k="llama runtime" v="/opt/llama (read-only host bind)" />
        <Row k="ml artifacts" v={an.cfg?.mlDir ?? "—"} />
        <Row k="warehouse sqlite" v="/opt/qwen-ml/analytics.db · host bind" />
        <Row k="warehouse redis" v="docker named volume · AOF" />
      </Card>
      <Card cls="ac-wh" title="Persistence">
        <Row k="✓ model store" v="/opt/qwen-model gguf · host bind, survives down -v" />
        <Row k="✓ analytics sqlite" v="/opt/qwen-ml/analytics.db · host bind, survives down -v" />
        <Row k="✓ ml artifacts" v="/opt/qwen-ml risk tflite + savedmodel · host bind" />
        <Row k="✗ redis working copy" v="docker named volume · wiped on down -v (sqlite is source of truth)" />
      </Card>
    </>
  );
}

export function Infrastructure() {
  const connectionIds = CHECKS.filter((c) => c.kind === "connection").map((c) => c.id);
  const pipelineIds = CHECKS.filter((c) => c.kind === "pipeline").map((c) => c.id);
  return (
    <div className="grid gap-4 grid-cols-1">
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {connectionIds.map((id) => (
          <CheckCard key={id} id={id} />
        ))}
      </div>
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {pipelineIds.map((id) => (
          <CheckCard key={id} id={id} />
        ))}
      </div>
      <HostCard />
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        <StorageCards />
      </div>
    </div>
  );
}