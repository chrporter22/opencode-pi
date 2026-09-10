import { useEffect, useRef, useState } from "react";
import { useStoreSlice, useStoreState } from "./store/core";
import { analyticsStore } from "./store/analytics";
import { opsStore } from "./store/ops";
import { statusStore } from "./store/status";
import { setTheme, setView, toggleSidebar, uiStore } from "./store/ui";
import type { ThemeId, UiState } from "./store/ui";
import { connectWs, closeWs } from "./lib/ws";
import { loadLogHistory, refresh } from "./lib/load";
import { usePageVisible, useVisibleInterval } from "./lib/useFrame";
import { fmtBytes } from "./lib/fmt";
import { Overview } from "./components/Overview";
import { Infrastructure } from "./components/Infrastructure";
import { Pipelines } from "./components/Pipelines";
import { Warehouse } from "./components/Warehouse";
import { Logs } from "./components/Logs";
import { Metrics } from "./components/Metrics";
import { ML } from "./components/MLAnalytics";
import { Playground } from "./components/Playground";
import { Documents } from "./components/Documents";

const THEMES: { id: ThemeId; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "viridis", label: "Viridis" },
  { id: "whale", label: "Whale" },
  { id: "rose-pine", label: "Rose-pine" },
];

export const VIEWS: { id: UiState["view"]; label: string; section: string }[] = [
  { id: "overview", label: "Overview", section: "Control" },
  { id: "infrastructure", label: "Infrastructure", section: "System" },
  { id: "pipelines", label: "Pipelines", section: "System" },
  { id: "warehouse", label: "Warehouse", section: "System" },
  { id: "logs", label: "Logs", section: "System" },
  { id: "metrics", label: "Metrics", section: "System" },
  { id: "ml", label: "ML Analytics", section: "Model" },
  { id: "playground", label: "Playground", section: "Tools" },
  { id: "documents", label: "Documents", section: "Tools" },
];

function Clock() {
  const clock = useStoreSlice(uiStore, (s) => s.clock);
  return <span className="dim text-[12px] tabular-nums shrink-0">{clock}</span>;
}

function initials(label: string): string {
  return label.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 3);
}

function Sidebar() {
  const ui = useStoreState(uiStore);
  const collapsed = ui.sidebarCollapsed;
  const status = useStoreSlice(statusStore, (s) => s.status);
  const meta = useStoreSlice(statusStore, (s) => s.meta);
  const infer = useStoreSlice(analyticsStore, (s) => s.infer);
  const training = useStoreSlice(analyticsStore, (s) => s.training);
  const sys = useStoreSlice(statusStore, (s) => s.sys);
  const [keysOpen, setKeysOpen] = useState(false);
  const [adminK, setAdminK] = useState(ui.adminKey);
  const [inferK, setInferK] = useState(ui.inferenceKey);

  const applyKeys = () => {
    const a = adminK.trim();
    if (a !== ui.adminKey) {
      uiStore.set({ adminKey: a, keyOk: !!a });
      try { localStorage.setItem("adminKey", a); } catch {}
      closeWs();
      if (a) {
        statusStore.set({ healthOk: false });
        void refresh();
        void loadLogHistory();
        connectWs();
      }
    }
    const iq = inferK;
    if (iq !== ui.inferenceKey) {
      uiStore.set({ inferenceKey: iq });
      try { localStorage.setItem("inferenceKey", iq); } catch {}
    }
    setKeysOpen(false);
  };

  const groups: { title: string; items: typeof VIEWS }[] = [];
  for (const v of VIEWS) {
    const g = groups.find((x) => x.title === v.section);
    if (g) g.items.push(v);
    else groups.push({ title: v.section, items: [v] });
  }

  return (
    <>
      <header className="flex items-center gap-2 px-3 py-3 border-b border-border">
        <span className="dot ok pulse" title="gateway ws" />
        {!collapsed ? (
          <>
            <h1 className="text-[13px] font-semibold tracking-wide">opencode-pi</h1>
            <span className="font-mono text-[11px] text-faint">control-center</span>
          </>
        ) : (
          <span className="font-mono text-[12px] text-dim">pi</span>
        )}
        <button
          className="btn-mini ml-auto shrink-0"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => toggleSidebar()}
        >
          {collapsed ? "»" : "«"}
        </button>
      </header>

      <nav className={"px-2 py-2 overflow-x-hidden overflow-y-auto " + (collapsed ? "space-y-3" : "space-y-3")}>
        {groups.map((g) => (
          <div key={g.title}>
            {!collapsed ? (
              <div className="px-2 pb-1 text-[10px] uppercase tracking-[0.14em] text-faint">{g.title}</div>
            ) : (
              <div className="px-1 pb-1 text-center text-[9px] text-faint">{g.title.slice(0, 2).toUpperCase()}</div>
            )}
            {g.items.map((v) =>
              collapsed ? (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  title={v.label}
                  className={
                    "block w-full text-center px-1 py-1.5 text-[12px] rounded transition-colors " +
                    (ui.view === v.id ? "bg-accent text-bg" : "text-dim hover:text-fg hover:bg-bar")
                  }
                >
                  {initials(v.label)}
                </button>
              ) : (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  className={
                    "block w-full text-left px-2 py-1.5 text-[13px] rounded transition-colors " +
                    (ui.view === v.id ? "bg-accent text-bg" : "text-dim hover:text-fg hover:bg-bar")
                  }
                >
                  {v.label}
                </button>
              )
            )}
          </div>
        ))}
      </nav>

      {!collapsed ? (
        <>
          <div className="px-3 py-3 mt-auto border-y border-border bg-bar space-y-2">
        <button
          className="btn-mini w-full justify-center"
          onClick={() => { setAdminK(ui.adminKey); setInferK(ui.inferenceKey); setKeysOpen(true); }}
          title="Set admin + inference API keys"
        >
          api keys{ui.adminKey ? " · set" : ""}
        </button>
      </div>

      <div className="px-3 py-3 space-y-2 text-[12px]">
        <div className="flex items-center gap-1.5 flex-wrap">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={
                "btn-mini " + (ui.theme === t.id ? "!bg-accent !text-bg !border-accent" : "")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-dim cursor-pointer">
          <input
            type="checkbox"
            checked={ui.compact}
            onChange={(e) => {
              uiStore.set({ compact: e.target.checked });
              try {
                localStorage.setItem("piCompact", e.target.checked ? "1" : "0");
              } catch {}
            }}
          />
          compact rows
        </label>
        <div className="text-[11px] text-faint leading-relaxed">
          <div>gateway {status?.gateway ?? "…"}</div>
          <div>llama {status?.llama ?? "…"}</div>
          <div className="truncate" title={meta?.name}>
            {(meta ? [meta.name, meta.quantization].filter(Boolean).join(" · ") : "…") ?? "…"}
          </div>
          <div>{infer?.label ? "log-reg " + infer.label : "log-reg …"}</div>
          {training?.state ? <div>{training.state}</div> : null}
          {sys?.cpu != null ? <div>cpu {sys.cpu.toFixed(0)}% · mem {sys.memory?.toFixed(0)}%</div> : null}
        </div>
      </div>
      </>
      ) : null}
      {keysOpen ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 print:hidden" onClick={() => setKeysOpen(false)} data-keys-modal>
          <div className="card w-full max-w-[340px] p-4" onClick={(e) => e.stopPropagation()}>
            <h2>API keys</h2>
            <div className="space-y-2 mt-2 text-[12px]">
              <label className="flex items-center gap-2 text-dim">admin
                <input
                  type="password"
                  value={adminK}
                  onChange={(e) => setAdminK(e.target.value)}
                  placeholder="admin key"
                  className="flex-1 min-w-0 bg-input border border-border rounded px-2 py-1 font-mono text-[11px]"
                />
              </label>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="muted">admin key gates control + ws feed</span>
                <span className={"chip " + (adminK ? "ok" : "")}>{adminK ? "set" : "unset"}</span>
              </div>
              <label className="flex items-center gap-2 text-dim">inference
                <input
                  type="password"
                  value={inferK}
                  onChange={(e) => setInferK(e.target.value)}
                  placeholder="inference key"
                  className="flex-1 min-w-0 bg-input border border-border rounded px-2 py-1 font-mono text-[11px]"
                />
              </label>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="muted">inference key gates /v1 model calls</span>
                <span className={"chip " + (inferK ? "ok" : "")}>{inferK ? "set" : "unset"}</span>
              </div>
            </div>
            <div className="row actions mt-3">
              <button className="btn" onClick={() => void applyKeys()}>Save keys</button>
              <button className="btn-mini" onClick={() => setKeysOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function StatusBar() {
  const ui = useStoreState(uiStore);
  const status = useStoreSlice(statusStore, (s) => s.status);
  const sys = useStoreSlice(statusStore, (s) => s.sys);
  const meta = useStoreSlice(statusStore, (s) => s.meta);
  const an = useStoreSlice(analyticsStore, (s) => s);
  const reqs = useStoreSlice(opsStore, (s) => ({ len: s.requests.length, active: s.requests.filter((r) => r.status === "started").length }));
  const collapsed = useStoreSlice(uiStore, (s) => s.sidebarCollapsed);
  const mountRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  const tick = Math.max(0, now - mountRef.current) / 1000;
  const el = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h > 0 ? h + ":" : "") + String(m).padStart(h > 0 ? 2 : 1, "0") + ":" + String(Math.floor(r)).padStart(2, "0") + "." + String(Math.floor((r % 1) * 10));
  };
  const ctxCount = an.risk?.contextWindows ?? an.meta?.context?.count ?? 0;
  const ctxCap = an.risk?.contextCap ?? an.meta?.context?.cap ?? 0;
  const perMs = an.risk?.computeMs ?? null;
  const remain = ctxCap - ctxCount;
  const secsLeft = perMs != null && remain > 0 ? Math.max(0, Math.round((remain * perMs) / 1000)) : null;

  return (
    <footer className={"hidden lg:flex md:flex items-center justify-between gap-4 px-4 h-8 border-t border-border bg-bar text-[11px] text-dim fixed bottom-0 right-0 z-30 transition-[left] " + (collapsed ? "left-[52px]" : "left-[220px]")}>
      <div className="flex items-center gap-3 min-w-0 overflow-x-auto">
        <span className="chip ok">{status?.gateway ?? "…"}</span>
        <span className="chips">
          <span className={"chip " + (sys?.cpu != null ? (sys.cpu > 70 ? "err" : "ok") : "pending")}>
            cpu {sys?.cpu != null ? sys.cpu.toFixed(0) + "%" : "…"}
          </span>
          <span className={"chip " + (sys?.memory != null ? (sys.memory > 70 ? "err" : "ok") : "pending")}>
            mem {sys?.memory != null ? sys.memory.toFixed(0) + "%" : "…"}
          </span>
          <span className="chip">{sys?.temperature != null ? sys.temperature.toFixed(1) + "°C" : "…"}</span>
          <span className="chip">{sys?.tokensPerSecond != null ? sys.tokensPerSecond.toFixed(1) + " t/s" : "…"}</span>
          <span className="chip">{sys?.requestsPerMinute != null ? sys.requestsPerMinute.toFixed(1) + " req/min" : "…"}</span>
        </span>
        <span className="chips">
          <span className={"chip " + (status?.llama === "ready" || status?.llama === "online" ? "ok" : "err")}>llama {status?.llama ?? "…"}</span>
          <span className="chip">{meta?.loadingStatus ?? "…"}</span>
          <span className="chip">{an.infer?.label ? "log-reg " + an.infer.label : "log-reg …"}</span>
          <span className="chip">{an.meta?.latency?.lastComputeMs != null ? "compute " + an.meta.latency.lastComputeMs + "ms" : "compute …"}</span>
        </span>
        {ui.view === "ml" ? (
          <span className="chips" data-ml-ticker>
            <span className="chip mono" data-ml-elapsed title="elapsed since page load · keeps counting">pipeline {el(tick)}</span>
            <span className="chip mono" data-ml-ctx title="window data-points logged into the context buffer feeding PCA labeling">ctx {ctxCount}/{ctxCap} pts</span>
            <span className="chip mono" data-ml-fill title="estimated seconds until the context pipeline fills to its cap">{secsLeft == null ? "ctx " + (remain <= 0 ? "full" : "fill …") : "fill est " + secsLeft + "s"}</span>
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="dim">{reqs.active} active · {reqs.len} requests</span>
        <span className="dim">{an.cloud.length > 0 ? an.cloud.length + " cloud pts" : ""}</span>
        <span className="dim">{meta?.sizeBytes != null ? fmtBytes(meta.sizeBytes) : ""}</span>
        <span className="chips">
          <span className="chip">{ui.view}</span>
          <Clock />
        </span>
      </div>
    </footer>
  );
}

export function App() {
  const view = useStoreSlice(uiStore, (s) => s.view);
  const theme = useStoreSlice(uiStore, (s) => s.theme);
  const compact = useStoreSlice(uiStore, (s) => s.compact);
  const collapsed = useStoreSlice(uiStore, (s) => s.sidebarCollapsed);
  const visible = usePageVisible();

  useEffect(() => {
    document.body.dataset.theme = theme;
    document.documentElement.style.setProperty("--font-mono", "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'SF Mono', 'Monaco', monospace");
  }, [theme]);

  useEffect(() => {
    document.body.dataset.compact = compact ? "1" : "0";
  }, [compact]);

  useEffect(() => {
    const id = window.setInterval(() => uiStore.set({ clock: new Date().toLocaleTimeString() }), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void refresh();
    void loadLogHistory();
    connectWs();
    return () => {
      closeWs();
    };
  }, []);

  useVisibleInterval(() => {
    void refresh();
  }, 5000, visible);

  return (
    <div className={compact ? "text-[13px]" : "text-[14px]"} data-view={view}>
      <aside
        className={
          "fixed top-0 bottom-0 left-0 border-r border-border flex flex-col z-40 print:hidden bg-sidebar " +
          (collapsed ? "w-[52px]" : "w-[220px]")
        }
      >
        <Sidebar />
      </aside>
      <main className={"pr-4 pb-10 min-h-screen transition-[padding] " + (collapsed ? "pl-[52px]" : "pl-[220px]")}>
        <div className="max-w-[1600px] mx-auto py-4 px-4">
          {view === "overview" && <Overview />}
          {view === "infrastructure" && <Infrastructure />}
          {view === "pipelines" && <Pipelines />}
          {view === "warehouse" && <Warehouse />}
          {view === "logs" && <Logs />}
          {view === "metrics" && <Metrics />}
          {view === "ml" && <ML />}
          {view === "playground" && <Playground />}
          {view === "documents" && <Documents />}
        </div>
      </main>
      <StatusBar />
    </div>
  );
}