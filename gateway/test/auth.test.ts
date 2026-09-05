import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createAuth, extractKey, requireAuth } from "../src/auth.js";

const auth = createAuth({ inferenceKey: "inf-key", adminKey: "admin-key" });

function buildApp() {
  const app = express();
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/x", requireAuth(auth, "admin"), (_req, res) => res.json({ ok: true }));
  app.get("/v1/x", requireAuth(auth, "inference"), (_req, res) => res.json({ ok: true }));
  return app;
}

const app = buildApp();

describe("auth", () => {
  it("leaves /health open", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("rejects missing key with 401", async () => {
    const res = await request(app).get("/api/x");
    expect(res.status).toBe(401);
  });

  it("rejects an unknown key with 401", async () => {
    const res = await request(app).get("/api/x").set("x-api-key", "nope");
    expect(res.status).toBe(401);
  });

  it("accepts the admin key via x-api-key header", async () => {
    const res = await request(app).get("/api/x").set("x-api-key", "admin-key");
    expect(res.status).toBe(200);
  });

  it("accepts the admin key via Authorization Bearer", async () => {
    const res = await request(app).get("/api/x").set("Authorization", "Bearer admin-key");
    expect(res.status).toBe(200);
  });

  it("separates scopes: inference key cannot hit /api/*", async () => {
    const res = await request(app).get("/api/x").set("x-api-key", "inf-key");
    expect(res.status).toBe(401);
  });

  it("separates scopes: admin key cannot hit /v1/*", async () => {
    const res = await request(app).get("/v1/x").set("x-api-key", "admin-key");
    expect(res.status).toBe(401);
  });

  it("accepts the inference key on /v1/*", async () => {
    const res = await request(app).get("/v1/x").set("x-api-key", "inf-key");
    expect(res.status).toBe(200);
  });

  it("extractKey prefers x-api-key over Bearer", () => {
    const req = { headers: { "x-api-key": "h", authorization: "Bearer b" } } as never;
    expect(extractKey(req)).toBe("h");
  });

  it("extractKey returns undefined without credentials", () => {
    const req = { headers: {} } as never;
    expect(extractKey(req)).toBeUndefined();
  });
});