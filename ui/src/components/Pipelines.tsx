import { useStoreSlice } from "../store/core";
import { analyticsStore } from "../store/analytics";
import { opsStore } from "../store/ops";
import { statusStore } from "../store/status";
import { fmtBytes } from "../lib/fmt";
import { Card, Row } from "./ui";
import { StreamsTable } from "./StreamsTable";
import { Note } from "./Note";

export function Pipelines() {
  const status = useStoreSlice(statusStore, (s) => s.status);
  const st = useStoreSlice(statusStore, (s) => s.meta);
  const sys = useStoreSlice(statusStore, (s) => s.sys);
  const an = useStoreSlice(analyticsStore, (s) => s);
  const sync = useStoreSlice(opsStore, (s) => s.sync);
  const reqs = useStoreSlice(opsStore, (s) => s.requests);

  const wsql = [...sync].reverse().find((x) => x.name === "warehouse sqlite");
  const wred = [...sync].reverse().find((x) => x.name === "warehouse redis");
  const mlm = [...sync].reverse().find((x) => x.name === "ml artifact store");
  const active = reqs.filter((r) => r.status === "started").length;
  const bytes = reqs.reduce((n, r) => n + (r.totalTokens ?? 0), 0);
  const last = reqs[reqs.length - 1];

  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
      <Card cls="ac-pg" title="llama inference">
        <div className="row"><span className="k">status</span><span className={"chip " + (status?.llama === "ready" || status?.llama === "online" ? "ok" : "err")}>{status?.llama ?? "—"}</span></div>
        <Row k="kind" v="server · /v1/chat/completions" />
        <Row k="endpoint" v={llamaEndpoint(st?.llamaArgs)} />
        <Row k="events/sec" v={sys?.requestsPerMinute != null ? (sys.requestsPerMinute / 60).toFixed(2) : "—"} />
        <Row k="bytes (≈ tokens)" v={bytes ? fmtBytes(bytes) : "—"} />
        <Row k="tok/s" v={sys?.tokensPerSecond != null ? sys.tokensPerSecond.toFixed(1) : "—"} />
        <Row k="last-seen" v={last ? new Date(last.startedAt).toLocaleTimeString() : "—"} />
        <Note id="inference" />
      </Card>

      <Card cls="ac-model" title="model update">
        <div className="row"><span className="k">status</span><span className={"chip " + (an.training?.state === "running" ? "warn" : st?.loadingStatus === "error" ? "err" : st?.loadingStatus === "loading" ? "warn" : "ok")}>{st?.loadingStatus ?? "idle"}</span></div>
        <Row k="kind" v="job · download → verify → swap" />
        <Row k="quant" v={st?.quantization ?? "—"} />
        <Row k="size" v={fmtBytes(st?.sizeBytes)} />
        <Row k="file" v={st?.file ?? "—"} />
        <Row k="installed" v={st?.installedAt ?? "—"} />
        <Note id="update" />
      </Card>

      <Card cls="ac-wh full" title="analytics warehouse">
        <div className="row"><span className="k">status</span><span className={"chip " + (wsql ? "ok" : "pending")}>{wsql?.note ?? "not synced"}</span></div>
        <Row k="pipeline" v="ingest → windows · requests → reference → scoring → training_runs → models" />
        <Row k="sqlite tables" v={wsql?.note ?? "—"} />
        <Row k="redis backing" v={wred ? (wred.note ?? "—") : "not synced"} />
        <Row k="scores path" v="sqlite → risk SSE (/v1/analytics/stream) → WS fan-out to UI" />
        <Row k="db file" v="/opt/qwen-ml/analytics.db" />
        <Row k="raw history" v={an.hist.length ? an.hist.length + " windows loaded" : "—"} />
        <Note id="warehouse" />
      </Card>

      <Card cls="ac-model full" title="TF training pipeline">
        <Row k="pipeline" v="label windows → auto retrain → export savedmodel → tflite → live classify" />
        <Row k="artifacts dir" v={an.cfg?.mlDir ?? "—"} />
        <Row k="model" v={an.training?.modelActive ? "tflite " + fmtBytes(an.training.tfliteBytes) : "no model"} />
        <Row k="trials · epochs" v={(an.training?.best ? "best F1 " + (an.training.best.metrics?.f1 ?? 0).toFixed(3) : "—") + " · " + (an.training?.epochs ?? "—")} />
        <Row k="next run" v={an.cfg?.nextRun ?? "—"} />
        <Row k="ml store" v={mlm?.note ?? "not synced"} />
        <Note id="ml" />
      </Card>

      <Card cls="ac-stream full" title="Client request streams">
        <div className="row">
          <span className="k">events/sec · bytes · last-seen</span>
          <span>
            <span className="chip">{sys?.requestsPerMinute != null ? (sys.requestsPerMinute / 60).toFixed(2) : "—"} /s</span>
            <span className="chip">{bytes ? fmtBytes(bytes) : "—"}</span>
            <span className="chip">{last ? new Date(last.startedAt).toLocaleTimeString() : "—"}</span>
            <span className={"chip " + (active > 0 ? "warn" : "")}>{active > 0 ? active + " active" : "idle"}</span>
          </span>
        </div>
        <StreamsTable />
        <Note id="streams" />
      </Card>

      <Card cls="ac-evt full" title="Pipeline live stream">
        <Pipelinelog />
      </Card>
    </div>
  );
}

function Pipelinelog() {
  const logs = useStoreSlice(opsStore, (s) => s.logs);
  const last = logs.slice(-150);
  return (
    <div className="log" data-live="pipe">
      {last.map((e, i) => {
        const label = logTag(e.msg);
        return (
          <div key={i} className="evt">
            <span className="t">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={"tag " + label.cls}>{label.text}</span>
            <span className="msg">{e.msg.slice(0, 180)}</span>
          </div>
        );
      })}
    </div>
  );
}

function logTag(msg: string): { text: string; cls: string } {
  if (/training|trial|epoch|f1|watermark|tf-lite|tflite/i.test(msg)) return { text: "ml", cls: "ml" };
  if (/analytics|ingest|window|reference|risk|warehouse/i.test(msg)) return { text: "wh", cls: "info" };
  if (/request|llama|model|v1\/chat/i.test(msg)) return { text: "inf", cls: "err" };
  return { text: "sys", cls: "dim" };
}

function llamaEndpoint(args?: string | null): string {
  if (!args) return "—";
  const h = args.match(/--host\s+(\S+)/);
  const p = args.match(/--port\s+(\S+)/);
  return (h ? h[1] : "?") + ":" + (p ? p[1] : "?");
}