import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModelContext, ModelEvents } from "../types.js";
import { installModelFromFile } from "../model-store.js";

export interface UpdateModelInput {
  ctx: ModelContext;
  url?: string;
  events: ModelEvents;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function updateModelAction(opts: UpdateModelInput): Promise<void> {
  const { ctx, events } = opts;
  const url = opts.url ?? ctx.url;
  if (!url) {
    throw new Error("MODEL_URL is required to update the model");
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const tmpDir = `${ctx.dir}/.download`;
  const tmpFile = `${tmpDir}/source.gguf`;

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    events.log("info", `Downloading model from ${url}`);
    const res = await fetchImpl(url, { signal: opts.signal, redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`model download failed: HTTP ${res.status}`);
    }
    const total = Number(res.headers.get("content-length") ?? 0);

    let written = 0;
    events.progress?.({ phase: "downloading", percent: 0 });
    await pipeline(
      Readable.fromWeb(
        res.body as import("node:stream/web").ReadableStream<Uint8Array>
      ),
      new Transform({
        transform(chunk, _enc, cb) {
          written += chunk.length;
          if (total > 0) {
            events.progress?.({
              phase: "downloading",
              percent: Math.min(100, Math.round((written / total) * 100)),
            });
          }
          cb(null, chunk);
        },
      }),
      createWriteStream(tmpFile)
    );

    await installModelFromFile(ctx, { source: tmpFile, events });
    events.log("info", "Model update complete");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}