import { statfs } from "node:fs/promises";
import { readFileSync } from "node:fs";

export interface SystemSnapshot {
  timestamp: number;
  cpu: number | null;
  memory: number | null;
  temperature: number | null;
  disk: {
    usedPercent: number | null;
    availableBytes: number | null;
  };
  tokensPerSecond: number;
}

interface CpuCounters {
  idle: number;
  total: number;
}

function readCpuCounters(): CpuCounters | undefined {
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
    const parts = line.split(/\s+/);
    if (parts[0] !== "cpu") return undefined;
    const nums = parts.slice(1).map(Number);
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
    const total = nums.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return undefined;
  }
}

function readMemoryPct(): number | null {
  try {
    const lines = readFileSync("/proc/meminfo", "utf8").split("\n");
    let total = 0;
    let available = 0;
    for (const line of lines) {
      if (line.startsWith("MemTotal:")) total = Number(line.split(/\s+/)[1]);
      if (line.startsWith("MemAvailable:")) available = Number(line.split(/\s+/)[1]);
    }
    if (total === 0) return null;
    return Math.round(((total - available) / total) * 1000) / 10;
  } catch {
    return null;
  }
}

const THERMAL_ZONES = ["/sys/class/thermal/thermal_zone0/temp", "/sys/class/thermal/thermal_zone1/temp"];

function readTemperature(): number | null {
  for (const zone of THERMAL_ZONES) {
    try {
      const raw = Number(readFileSync(zone, "utf8").trim());
      if (Number.isFinite(raw)) return Math.round(raw / 100) / 10;
    } catch {
      // try next zone
    }
  }
  return null;
}

async function readDisk(dir: string): Promise<{ usedPercent: number | null; availableBytes: number | null }> {
  try {
    const stats = await statfs(dir);
    const blockSize = stats.bsize;
    const totalBytes = stats.blocks * blockSize;
    const availableBytes = stats.bavail * blockSize;
    if (totalBytes === 0) return { usedPercent: null, availableBytes };
    const usedPercent = Math.round(((totalBytes - availableBytes) / totalBytes) * 1000) / 10;
    return { usedPercent, availableBytes };
  } catch {
    return { usedPercent: null, availableBytes: null };
  }
}

export interface MetricsOptions {
  getTokensPerSecond: () => number;
  modelsDir: string;
  intervalMs?: number;
}

export interface Metrics {
  snapshot(): Promise<SystemSnapshot>;
  subscribeSample(cb: (snapshot: SystemSnapshot) => void): () => void;
  start(): void;
  stop(): void;
}

export function createMetrics(opts: MetricsOptions): Metrics {
  let prevCpu: CpuCounters | undefined;
  let timer: NodeJS.Timeout | undefined;
  const sampleSubscribers = new Set<(snapshot: SystemSnapshot) => void>();

  async function snapshot(): Promise<SystemSnapshot> {
    const current = readCpuCounters();
    let cpu: number | null = null;
    if (current && prevCpu && current.total > prevCpu.total) {
      const idleDelta = current.idle - prevCpu.idle;
      const totalDelta = current.total - prevCpu.total;
      cpu = Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 1000) / 10));
    }
    prevCpu = current;

    return {
      timestamp: Date.now(),
      cpu,
      memory: readMemoryPct(),
      temperature: readTemperature(),
      disk: await readDisk(opts.modelsDir),
      tokensPerSecond: opts.getTokensPerSecond(),
    };
  }

  return {
    snapshot,
    subscribeSample(cb) {
      sampleSubscribers.add(cb);
      return () => {
        sampleSubscribers.delete(cb);
      };
    },
    start() {
      if (timer) return;
      const intervalMs = opts.intervalMs ?? 5000;
      timer = setInterval(() => {
        void snapshot().then((s) => {
          for (const cb of sampleSubscribers) cb(s);
        });
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}