import { Router } from "express";
import type { Logger } from "../logger.js";

export interface OpsDeps {
  logger: Logger;
  onRestartRequest: () => void;
}

export function opsRouter(deps: OpsDeps): Router {
  const router = Router();

  router.post("/model/update", (_req, res) => {
    res.status(501).json({
      error: "model update is not implemented yet",
      code: "not_implemented",
    });
  });

  router.post("/model/restart", (_req, res) => {
    res.status(501).json({
      error: "model restart is not implemented yet",
      code: "not_implemented",
    });
  });

  router.post("/server/restart", (_req, res) => {
    deps.logger.info("Server restart requested");
    res.status(202).json({ status: "restarting" });
    setTimeout(() => deps.onRestartRequest(), 50);
  });

  return router;
}