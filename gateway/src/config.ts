import { z } from "zod";

const MISSING = (v: unknown) => v === undefined || v === "";

const optionalString = z.preprocess(
  (v) => (MISSING(v) ? undefined : v),
  z.string().optional()
);

const optionalInt = z.preprocess(
  (v) => (MISSING(v) ? undefined : v),
  z.coerce.number().int().positive().optional()
);

const optionalSha256 = z.preprocess(
  (v) => (MISSING(v) ? undefined : v),
  z.string().regex(/^[0-9a-fA-F]{64}$/, "must be a 64-char hex SHA-256").optional()
);

const optionalUrl = z.preprocess(
  (v) => (MISSING(v) ? undefined : v),
  z.string().url("must be a valid URL").optional()
);

const envSchema = z.object({
  GATEWAY_HOST: z.string().default("0.0.0.0"),
  GATEWAY_PORT: z.coerce.number().int().positive().default(8080),
  INFERENCE_API_KEY: z.string().min(1, "INFERENCE_API_KEY is required"),
  ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),
  LLAMA_HOST: z.string().default("127.0.0.1"),
  LLAMA_PORT: z.coerce.number().int().positive().default(8000),
  LLAMA_BIN: z.string().default("/opt/llama/llama-server"),
  LLAMA_CONTEXT_SIZE: z.coerce.number().int().nonnegative().default(8192),
  LLAMA_THREADS: optionalInt,
  LLAMA_BATCH_SIZE: optionalInt,
  LLAMA_PARALLEL: optionalInt,
  LLAMA_EXTRA_ARGS: optionalString,
  MODEL_NAME: z.string().default("Qwen3-1.7B"),
  MODEL_URL: optionalUrl,
  MODEL_FILE: z.string().default("current.gguf"),
  MODEL_SHA256: optionalSha256,
  MODEL_DIR: z.string().default("/opt/qwen-model"),
  MODEL_QUANT: optionalString,
  AUTO_UPDATE_MODEL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AUTO_UPDATE_INTERVAL: z.string().default("24h"),
  ANALYTICS_URL: optionalUrl,
  INGEST_SECRET: optionalString,
  ANALYTICS_FEATURE_WINDOW_SEC: z.coerce.number().int().positive().default(60),
});

export const MODELS_CONTAINER_DIR = "/models";

export interface Config {
  gateway: { host: string; port: number };
  keys: { inference: string; admin: string };
  llama: {
    host: string;
    port: number;
    bin: string;
    contextSize: number;
    threads?: number;
    batchSize?: number;
    parallel?: number;
    extraArgs?: string;
    url: string;
  };
  model: {
    name: string;
    url?: string;
    file: string;
    sha256?: string;
    quant?: string;
    hostDir: string;
    containerDir: string;
    containerPath: string;
  };
  autoUpdate: { enabled: boolean; interval: string };
  analytics: {
    url?: string;
    ingestSecret?: string;
    windowSec: number;
  };
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(env);
  return {
    gateway: { host: parsed.GATEWAY_HOST, port: parsed.GATEWAY_PORT },
    keys: { inference: parsed.INFERENCE_API_KEY, admin: parsed.ADMIN_API_KEY },
    llama: {
      host: parsed.LLAMA_HOST,
      port: parsed.LLAMA_PORT,
      bin: parsed.LLAMA_BIN,
      contextSize: parsed.LLAMA_CONTEXT_SIZE,
      threads: parsed.LLAMA_THREADS,
      batchSize: parsed.LLAMA_BATCH_SIZE,
      parallel: parsed.LLAMA_PARALLEL,
      extraArgs: parsed.LLAMA_EXTRA_ARGS,
      url: `http://${parsed.LLAMA_HOST}:${parsed.LLAMA_PORT}`,
    },
    model: {
      name: parsed.MODEL_NAME,
      url: parsed.MODEL_URL,
      file: parsed.MODEL_FILE,
      sha256: parsed.MODEL_SHA256,
      quant: parsed.MODEL_QUANT,
      hostDir: parsed.MODEL_DIR,
      containerDir: MODELS_CONTAINER_DIR,
      containerPath: `${MODELS_CONTAINER_DIR}/${parsed.MODEL_FILE}`,
    },
    autoUpdate: { enabled: parsed.AUTO_UPDATE_MODEL, interval: parsed.AUTO_UPDATE_INTERVAL },
    analytics: {
      url: parsed.ANALYTICS_URL,
      ingestSecret: parsed.INGEST_SECRET,
      windowSec: parsed.ANALYTICS_FEATURE_WINDOW_SEC,
    },
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parseConfig(env);
}