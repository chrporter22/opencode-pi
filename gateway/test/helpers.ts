import type { Config } from "../src/config.js";

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    gateway: { host: "0.0.0.0", port: 8080 },
    keys: { inference: "test-inference-key", admin: "test-admin-key" },
    llama: { host: "127.0.0.1", port: 8000, bin: "/opt/llama/llama-server", contextSize: 8192 },
    model: { name: "Qwen3-1.7B", file: "current.gguf", hostDir: "/opt/qwen-model", containerDir: "/models", containerPath: "/models/current.gguf" },
    autoUpdate: { enabled: false, interval: "24h" },
    ...overrides,
  };
}