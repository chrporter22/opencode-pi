import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type AuthScope = "admin" | "inference";

export interface AuthContext {
  inferenceKey: string;
  adminKey: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function extractKey(req: Request): string | undefined {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.length > 0) return header;

  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match && match[1].length > 0) return match[1];
  }
  return undefined;
}

export function isAdminKey(ctx: AuthContext, key: string | undefined): boolean {
  return typeof key === "string" && key.length > 0 && safeEqual(key, ctx.adminKey);
}

export function isInferenceKey(ctx: AuthContext, key: string | undefined): boolean {
  return typeof key === "string" && key.length > 0 && safeEqual(key, ctx.inferenceKey);
}

export function requireAuth(ctx: AuthContext, scope: AuthScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = extractKey(req);
    const valid = scope === "admin" ? isAdminKey(ctx, key) : isInferenceKey(ctx, key);
    if (!valid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function createAuth(ctx: AuthContext): AuthContext {
  return ctx;
}