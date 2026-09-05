export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  log(level: LogLevel, msg: string): void;
  snapshot(): LogEntry[];
  subscribe(cb: (entry: LogEntry) => void): () => void;
}

export interface LoggerOptions {
  maxEntries?: number;
  minLevel?: LogLevel;
  stdout?: boolean;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const maxEntries = opts.maxEntries ?? 1000;
  const minRank = LEVEL_ORDER[opts.minLevel ?? "debug"];
  const stdout = opts.stdout ?? true;
  const ring: LogEntry[] = [];
  const subscribers = new Set<(entry: LogEntry) => void>();

  function emit(level: LogLevel, msg: string): void {
    if (LEVEL_ORDER[level] < minRank) return;
    const entry: LogEntry = { ts: Date.now(), level, msg };
    ring.push(entry);
    if (ring.length > maxEntries) ring.splice(0, ring.length - maxEntries);
    if (stdout) console.log(`[${level}] ${msg}`);
    for (const cb of subscribers) cb(entry);
  }

  return {
    debug: (msg) => emit("debug", msg),
    info: (msg) => emit("info", msg),
    warn: (msg) => emit("warn", msg),
    error: (msg) => emit("error", msg),
    log: (level, msg) => emit(level, msg),
    snapshot: () => [...ring],
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}

export const logger = createLogger({ minLevel: "info" });