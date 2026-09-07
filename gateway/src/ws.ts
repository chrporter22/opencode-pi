import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthContext } from "./auth.js";
import { isAdminKey } from "./auth.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { RequestRecord, RequestTracker } from "./requests.js";
import type { RuntimeEvent, RuntimeState } from "./state.js";

export interface WsServerOptions {
  httpServer: HttpServer;
  auth: AuthContext;
  state: RuntimeState;
  metrics: Metrics;
  logger: Logger;
  requests: RequestTracker;
}

export interface WsServer {
  broadcast(obj: Record<string, unknown>): void;
  close(): void;
}

export function startWsServer(opts: WsServerOptions): WsServer {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  function broadcast(obj: Record<string, unknown>): void {
    const payload = JSON.stringify(obj);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  opts.httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const key = url.searchParams.get("key") ?? undefined;
    if (!isAdminKey(opts.auth, key)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => {
      clients.delete(ws);
    });
    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  const onStateChange = (event: RuntimeEvent): void => {
    broadcast({ ...event });
  };

  const onLog = (entry: { ts: number; level: string; msg: string }): void => {
    broadcast({ type: "log", timestamp: entry.ts, level: entry.level, message: entry.msg });
  };

  const onMetrics = (snapshot: { timestamp: number; cpu: number | null; memory: number | null; temperature: number | null; tokensPerSecond: number }): void => {
    broadcast({
      type: "system.metrics",
      timestamp: snapshot.timestamp,
      cpu: snapshot.cpu,
      memory: snapshot.memory,
      temperature: snapshot.temperature,
      tokensPerSecond: snapshot.tokensPerSecond,
      requestsPerMinute: opts.requests.requestsPerMinute(),
    });
  };

  const onRequest = (record: RequestRecord): void => {
    broadcast({
      type:
        record.status === "started"
          ? "request.started"
          : record.status === "completed"
            ? "request.completed"
            : "request.error",
      timestamp: record.startedAt,
      id: record.id,
      method: record.method,
      path: record.path,
      model: record.model,
      source: record.source,
      ip: record.ip,
      status: record.status,
      durationMs: record.durationMs,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      totalTokens: record.totalTokens,
      tokensPerSecond: record.tokensPerSecond,
      error: record.error,
    });
  };

  opts.state.on("change", onStateChange);
  opts.logger.subscribe(onLog);
  opts.metrics.subscribeSample(onMetrics);
  const unsubscribeRequests = opts.requests.subscribe(onRequest);

  return {
    broadcast,
    close() {
      opts.state.off("change", onStateChange);
      unsubscribeRequests();
      for (const client of clients) client.terminate();
      clients.clear();
      wss.close();
    },
  };
}