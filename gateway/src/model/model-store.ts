import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { ModelContext, ModelEvents, ModelMetadata } from "./types.js";

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

export async function readMetadata(ctx: ModelContext, displayName: string): Promise<ModelMetadata> {
  const target = `${ctx.dir}/${ctx.file}`;
  try {
    const st = await stat(target);
    return {
      name: displayName,
      file: ctx.file,
      quantization: undefined,
      installed: true,
      sizeBytes: st.size,
      installedAt: st.mtime.toISOString(),
      sha256: ctx.sha256,
      downloadUrl: ctx.url,
    };
  } catch {
    return {
      name: displayName,
      file: ctx.file,
      quantization: undefined,
      installed: false,
      sizeBytes: null,
      installedAt: null,
      sha256: ctx.sha256,
      downloadUrl: ctx.url,
    };
  }
}

export interface InstallOptions {
  source: string;
  events: ModelEvents;
}

export async function installModelFromFile(ctx: ModelContext, opts: InstallOptions): Promise<void> {
  const { source, events } = opts;
  const target = `${ctx.dir}/${ctx.file}`;
  const stagingDir = `${ctx.dir}/.download`;
  const staging = `${stagingDir}/.${ctx.file}.tmp`;

  await mkdir(stagingDir, { recursive: true });
  try {
    events.progress?.({ phase: "verifying" });
    if (ctx.sha256) {
      const expected = await hashFile(source);
      if (expected.toLowerCase() !== ctx.sha256.toLowerCase()) {
        events.log("error", `SHA-256 mismatch: got ${expected}, expected ${ctx.sha256}`);
        throw new Error("model checksum mismatch");
      }
      events.log("info", "SHA-256 verified");
    }

    events.progress?.({ phase: "swapping" });
    await copyFile(source, staging);
    await rename(staging, target);
    events.log("info", `Installed model at ${target}`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}