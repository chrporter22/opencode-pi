import { readFileSync } from "node:fs";
import os from "node:os";

export interface HostInfo {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  uptimeSeconds: number;
  cpuModel: string;
  cpuCores: number;
  model: string | null;
  memoryTotalBytes: number;
  localIp: string | null;
}

function readOsPrettyName(): string {
  try {
    const release = readFileSync("/etc/os-release", "utf8");
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release);
    if (m) return m[1];
  } catch {
    // fall through to default
  }
  return "Linux";
}

function readPiModel(): string | null {
  try {
    const data = readFileSync("/proc/cpuinfo", "utf8");
    const m = /^Model\s*:\s*(.+)$/m.exec(data);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function readLocalIp(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

export function readHostInfo(): HostInfo {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    os: readOsPrettyName(),
    kernel: os.release(),
    arch: os.arch(),
    uptimeSeconds: Math.floor(os.uptime()),
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpuCores: cpus.length,
    model: readPiModel(),
    memoryTotalBytes: os.totalmem(),
    localIp: readLocalIp(),
  };
}