import { Router } from "express";
import { randomUUID } from "node:crypto";
import httpProxy from "http-proxy";
import type { ServerResponse as HttpServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { RequestTracker, RequestUsage } from "../requests.js";
import type { RuntimeState } from "../state.js";

export interface V1Deps {
  config: Config;
  state: RuntimeState;
  logger: Logger;
  requests: RequestTracker;
}

interface RequestMeta {
  id: string;
}

function sniffUsage(tail: string, acc: RequestUsage): void {
  const m = /"prompt_tokens":\s*(\d+)/.exec(tail);
  const c = /"completion_tokens":\s*(\d+)/.exec(tail);
  const t = /"total_tokens":\s*(\d+)/.exec(tail);
  if (m) acc.promptTokens = Number(m[1]);
  if (c) acc.completionTokens = Number(c[1]);
  if (t) acc.totalTokens = Number(t[1]);
}

export function v1Router(deps: V1Deps): Router {
  const router = Router();
  const proxy = httpProxy.createProxyServer({});

  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.removeHeader("authorization");
  });

  proxy.on("error", (err, _req, res) => {
    deps.logger.warn(`inference proxy error: ${err.message}`);
    const meta = (_req as { v1Meta?: RequestMeta }).v1Meta;
    if (meta) deps.requests.fail(meta.id, err.message);
    const target = res as HttpServerResponse;
    if (target.headersSent) {
      target.destroy();
    } else {
      target.writeHead(502, { "content-type": "application/json" });
      target.end(JSON.stringify({ error: "bad gateway", detail: "llama-server unreachable" }));
    }
  });

  router.use((req, res, next) => {
    const state = deps.state.snapshot();
    const track = req.path === "/chat/completions";
    const meta: RequestMeta | undefined = track ? { id: randomUUID() } : undefined;
    if (meta) (req as { v1Meta?: RequestMeta }).v1Meta = meta;
    if (state.llama !== "ready") {
      if (meta) {
        deps.requests.start({
          id: meta.id,
          method: req.method,
          path: req.path,
          model: deps.config.model.name,
        });
        deps.requests.fail(meta.id, "inference not ready");
      }
      res.status(503).json({
        error: "inference not ready",
        detail: `llama-server status: ${state.llama}`,
      });
      return;
    }
    if (meta) {
      deps.requests.start({
        id: meta.id,
        method: req.method,
        path: req.path,
        model: deps.config.model.name,
      });
    }
    next();
  });

  router.use((req, res) => {
    const meta = (req as { v1Meta?: RequestMeta }).v1Meta;
    if (!meta) {
      proxy.web(req, res, { target: deps.config.llama.url });
      return;
    }
    const usage: RequestUsage = { promptTokens: null, completionTokens: null, totalTokens: null };
    let tail = "";
    let resolved = false;

    const fail = (error: string): void => {
      if (resolved) return;
      resolved = true;
      deps.requests.fail(meta.id, error);
    };
    const complete = (): void => {
      if (resolved) return;
      resolved = true;
      deps.requests.complete(meta.id, usage);
    };

    const origWrite = res.write;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      const piece = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      tail = (tail + piece).slice(-256);
      sniffUsage(tail, usage);
      return (origWrite as (...args: unknown[]) => boolean).apply(res, [chunk, ...rest]);
    }) as typeof res.write;

    res.on("finish", complete);
    res.on("close", () => fail("client disconnected"));

    proxy.web(req, res, { target: deps.config.llama.url });
  });

  return router;
}