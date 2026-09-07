import { readFileSync } from "node:fs";
import os from "node:os";

export interface HostInfo {
  hostname: string;
  os: string;
  hostOs: string | null;
  kernel: string;
  arch: string;
  uptimeSeconds: number;
  cpuModel: string;
  cpuCores: number;
  model: string | null;
  memoryTotalBytes: number;
  localIp: string | null;
  mounts: MountInfo[];
}

export interface MountInfo {
  device: string;
  mount: string;
  fs: string;
}

function readOsPrettyName(file = "/etc/os-release"): string {
  try {
    const release = readFileSync(file, "utf8");
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release);
    if (m) return m[1];
  } catch {
    // fall through to default
  }
  return "Linux";
}

const MOUNTS_PROBE_FILES = ["/host-mounts", "/proc/mounts"];

export function parseMounts(contents: string): MountInfo[] {
  const seen = new Set<string>();
  const mounts: MountInfo[] = [];
  for (const line of contents.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [device, rawMount] = parts;
    if (!device.startsWith("/dev/")) continue;
    const mount = rawMount.replace(/\\040/g, " ");
    const fs = parts[2];
    const key = `${device}@${mount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mounts.push({ device, mount, fs });
  }
  return mounts;
}

function readHostOs(): string | null {
  try {
    const pretty = readOsPrettyName("/host-os-release");
    return pretty === "Linux" ? null : pretty;
  } catch {
    return null;
  }
}

function readMounts(): MountInfo[] {
  for (const file of MOUNTS_PROBE_FILES) {
    try {
      const parsed = parseMounts(readFileSync(file, "utf8"));
      if (parsed.length > 0) return parsed;
    } catch {
      // try next probe file
    }
  }
  return [];
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
    hostOs: readHostOs(),
    kernel: os.release(),
    arch: os.arch(),
    uptimeSeconds: Math.floor(os.uptime()),
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpuCores: cpus.length,
    model: readPiModel(),
    memoryTotalBytes: os.totalmem(),
    localIp: readLocalIp(),
    mounts: readMounts(),
  };
}