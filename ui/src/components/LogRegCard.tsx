import { useStoreSlice } from "../store/core";
import { analyticsStore } from "../store/analytics";
import { Card } from "./ui";

// Deterministic TF-Lite logistic-regression risk/class card.
// Primary: class + three probabilities.
// Secondary (folded): PCA/EWMA rows (T², p-value, compute/windows scored).
export function LogRegCard() {
  const { risk, infer } = useStoreSlice(analyticsStore, (s) => ({ risk: s.risk, infer: s.infer }));
  const pipeLabel = risk?.level ?? null;
  const label = (infer?.label ?? risk?.nnRisk) || null;
  const prob: number[] | null = (infer?.prob ?? risk?.nnProb) || null;
  const pc = (p: number) => (p >= 0.1 ? (p * 100).toFixed(0) + "%" : (p * 100).toFixed(1) + "%");
  const ms = infer?.ms ?? risk?.nnLatencyMs ?? null;
  const when = infer?.when;
  const t2 = risk?.t2;
  const pValue = risk?.pValue;
  const computeMs = risk?.computeMs;
  const windowsScored = risk?.windowsScored;
  const modelActive = risk?.modelActive;

  return (
    <Card cls="ac-model" title="Log-reg (TF-Lite) inference" id="nn-card">
      <div className="flex items-center gap-3 py-1">
        <span className={"chip " + (label === "normal" ? "ok" : label === "high" ? "err" : label === "watch" ? "warn" : "pending")}>{label ?? "—"}</span>
        <span className="dim text-[12px]">{when ? new Date(when).toLocaleTimeString() : "no live sample yet"}</span>
        <span className="chip">{pipeLabel ? "PCA " + pipeLabel : ""}</span>
        {ms != null ? <span className="chip ml-auto">{ms} ms</span> : null}
      </div>

      {prob && prob.length === 3 ? (
        <div className="grid grid-cols-3 gap-1.5 mt-1" data-nn-prob>
          {["normal", "watch", "high"].map((l, i) => {
            const tri = l === "watch" ? "217 164 4" : "var(--pi-" + (l === "normal" ? "ok" : "err") + ")";
            return (
              <div key={l} className="rounded border px-1.5 py-1 text-center select-none" style={{ borderColor: "rgb(" + tri + " / 0.6)", background: "rgb(" + tri + " / 0.10)" }}>
                <div className="text-[11px] uppercase tracking-wide leading-none">{l}</div>
                <div className="text-[14px] font-semibold tabular-nums leading-tight" style={{ color: "rgb(" + tri + " / 1)" }}>{pc(prob[i] ?? 0)}</div>
              </div>
            );
          })}
          <div className="col-span-3 text-faint text-[11px]">logistic-regression (tf-lite) model outcome · PCA {pipeLabel ?? "?"} = PCA/EWMA tier</div>
        </div>
      ) : (
        <div className="text-faint text-[12px] py-1">no probabilities yet</div>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-dim uppercase tracking-wide">PCA / EWMA</summary>
        <div className="mt-2 text-[12px] space-y-1">
          <div className="row"><span className="k">Hotelling T²</span><span className="mono">{t2 != null ? t2.toExponential(2) : "—"}</span></div>
          <div className="row"><span className="k">p-value</span><span className="mono">{pValue != null ? pValue.toExponential(2) : "—"}</span></div>
          <div className="row"><span className="k">compute</span><span className="mono">{computeMs != null ? computeMs + " ms" : "—"}</span></div>
          <div className="row"><span className="k">windows scored</span><span className="mono">{windowsScored ?? "—"}</span></div>
          <div className="row"><span className="k">model active</span><span className="mono">{modelActive != null ? String(modelActive) : "—"}</span></div>
        </div>
      </details>
    </Card>
  );
}