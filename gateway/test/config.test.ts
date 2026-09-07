import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

function env(overrides: Record<string, string> = {}) {
  return {
    INFERENCE_API_KEY: "inf",
    ADMIN_API_KEY: "admin",
    MODEL_URL: "https://example.com/model.gguf",
    ...overrides,
  };
}

describe("config", () => {
  it("parses a minimal valid environment with defaults", () => {
    const cfg = parseConfig(env());
    expect(cfg.gateway).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(cfg.keys).toEqual({ inference: "inf", admin: "admin" });
    expect(cfg.llama.host).toBe("127.0.0.1");
    expect(cfg.llama.port).toBe(8000);
    expect(cfg.llama.bin).toBe("/opt/llama/llama-server");
    expect(cfg.llama.contextSize).toBe(8192);
    expect(cfg.model.name).toBe("Qwen3-1.7B");
    expect(cfg.model.file).toBe("current.gguf");
    expect(cfg.model.containerPath).toBe("/models/current.gguf");
    expect(cfg.model.hostDir).toBe("/opt/qwen-model");
    expect(cfg.autoUpdate.enabled).toBe(false);
  });

  it("throws when a required key is missing", () => {
    expect(() => parseConfig({})).toThrow();
  });

  it("accepts empty optional fields as undefined", () => {
    const cfg = parseConfig(env({ MODEL_URL: "", MODEL_QUANT: "", MODEL_SHA256: "", LLAMA_THREADS: "" }));
    expect(cfg.model.url).toBeUndefined();
    expect(cfg.model.quant).toBeUndefined();
    expect(cfg.model.sha256).toBeUndefined();
    expect(cfg.llama.threads).toBeUndefined();
  });

  it("coerces numeric fields", () => {
    const cfg = parseConfig(env({ GATEWAY_PORT: "9000", LLAMA_CONTEXT_SIZE: "4096", LLAMA_THREADS: "4" }));
    expect(cfg.gateway.port).toBe(9000);
    expect(cfg.llama.contextSize).toBe(4096);
    expect(cfg.llama.threads).toBe(4);
  });

  it("validates a 64-char sha256", () => {
    const good = "a".repeat(64);
    expect(parseConfig(env({ MODEL_SHA256: good })).model.sha256).toBe(good);
    expect(() => parseConfig(env({ MODEL_SHA256: "too-short" }))).toThrow();
  });

  it("parses the auto-update opt-in flag", () => {
    expect(parseConfig(env()).autoUpdate.enabled).toBe(false);
    expect(parseConfig(env({ AUTO_UPDATE_MODEL: "true" })).autoUpdate.enabled).toBe(true);
  });

  it("parses analytics defaults and overrides", () => {
    const cfg = parseConfig(env());
    expect(cfg.analytics.url).toBeUndefined();
    expect(cfg.analytics.ingestSecret).toBeUndefined();
    expect(cfg.analytics.windowSec).toBe(60);

    const full = parseConfig(env({
      ANALYTICS_URL: "http://analytics:8081",
      INGEST_SECRET: "secret",
      ANALYTICS_FEATURE_WINDOW_SEC: "120",
    }));
    expect(full.analytics.url).toBe("http://analytics:8081");
    expect(full.analytics.ingestSecret).toBe("secret");
    expect(full.analytics.windowSec).toBe(120);
  });
});