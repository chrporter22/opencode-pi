import { Router } from "express";
import httpProxy from "http-proxy";
import type { ServerResponse as HttpServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { RuntimeState } from "../state.js";

export interface V1Deps {
  config: Config;
  state: RuntimeState;
  logger: Logger;
}

export function v1Router(deps: V1Deps): Router {
  const router = Router();
  const proxy = httpProxy.createProxyServer({});

  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.removeHeader("authorization");
  });

  proxy.on("error", (err, _req, res) => {
    deps.logger.warn(`inference proxy error: ${err.message}`);
    const target = res as HttpServerResponse;
    if (target.headersSent) {
      target.destroy();
    } else {
      target.writeHead(502, { "content-type": "application/json" });
      target.end(JSON.stringify({ error: "bad gateway", detail: "llama-server unreachable" }));
    }
  });

  router.use((req, res) => {
    const state = deps.state.snapshot();
    if (state.llama !== "ready") {
      res.status(503).json({
        error: "inference not ready",
        detail: `llama-server status: ${state.llama}`,
      });
      return;
    }
    proxy.web(req, res, {
      target: deps.config.llama.url,
    });
  });

  return router;
}