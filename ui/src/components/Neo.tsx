import { useStoreSlice } from "../store/core";
import { statusStore } from "../store/status";
import { fmtUptime, fmtBytes } from "../lib/fmt";

const ARCH_ART = [
  "                   -`",
  "                  .o+`",
  "                 `ooo/",
  "                `+oooo:",
  "               `+oooooo:",
  "               -+oooooo+:",
  "             `/:-:++oooo+:",
  "            `/++++/+++++++:",
  "           `/++++++++++++++:",
  "          `/+++ooooooooooooo/`",
  "         ./ooosssso++osssssso+`",
  "        .oossssso-````/ossssss+`",
  "       -osssssso.      :ssssssso.",
  "      :osssssss/        osssso+++.",
  "     /ossssssss/        +ssssooo/-",
  "   `/ossssso+/:-        -:/+osssso+-",
  "  `+sso+:-`                 `.-/+oso:",
  " `++:.                           `-/+/",
  " .`                                 `/",
].join("\n");

const DEB_ART = [
  "       _,met$$$$$gg.",
  "    ,g$$$$$$$$$$$$$$$P.",
  "  ,g$$P\"        \"\"\"Y$$\".",
  " ,$$P'              `$$$.",
  "',$$P       ,ggs.     `$$b:",
  "`d$$'     ,$P\"'   .    $$$",
  " $$P      d$'     ,    $$P",
  " $$:      $$.   -    ,d$$'",
  " $$;      Y$b._   _,d$P'",
  " Y$$.    `.`\"Y$$$$P\"'",
  " `$$b      \"-.__",
  "  `Y$$",
  "   `Y$$.",
  "     `$$b.",
  "       `Y$$b.",
  "          `\"Y$b._",
  "              `\"\"\"",
].join("\n");

function row(k: string, v: string | number | null | undefined, hot?: boolean): string {
  return `<div class="neo-row"><span class="neo-k">${k}</span><span class="neo-v${hot ? " hot" : ""}">${esc(v ?? "—")}</span></div>`;
}

function esc(v: string | number): string {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c],
  );
}

export function NeoFetch() {
  const host = useStoreSlice(statusStore, (s) => s.host);
  const sys = useStoreSlice(statusStore, (s) => s.sys);
  const lines = host ? [
    row("user@host", (host.hostname || "pi5") + "@rpi", true),
    row("os", host.hostOs || host.os || "Linux"),
    row("kernel", host.kernel),
    row("uptime", fmtUptime(host.uptimeSeconds)),
    row("cpu", (host.cpuModel || "—") + " · " + (host.cpuCores != null ? host.cpuCores + " cores" : "—")),
    row("memory", fmtBytes(host.memoryTotalBytes) + (sys?.memory != null ? ` (${sys.memory.toFixed(0)}% used)` : "")),
    row("temperature", sys?.temperature != null ? sys.temperature.toFixed(1) + "°C" : "—"),
    row("model", host.model),
    row("arch", host.arch),
    row("local ip", host.localIp),
  ].join("\n") : row("…", "loading host…");

  const art = (host?.os ?? "").toLowerCase().includes("debian") ? DEB_ART : ARCH_ART;
  return (
    <div className="neo-wrap flex gap-4 flex-wrap items-start justify-between">
      <div className={"neo-ascii " + ((host?.os ?? "").toLowerCase().includes("debian") ? "neo-deb" : "neo-arch")}>{art}</div>
      <div className="neo-info max-w-[340px] flex-1 space-y-0.5" dangerouslySetInnerHTML={{ __html: lines }} />
    </div>
  );
}