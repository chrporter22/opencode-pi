import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelContext } from "../src/model/types.js";
import { installModelFromFile } from "../src/model/model-store.js";
import { updateModelAction } from "../src/model/actions/update-model.action.js";
import { ensureModelAction } from "../src/model/actions/ensure-model.action.js";

const sha256Of = (data: Buffer) => createHash("sha256").update(data).digest("hex");

const tmpDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-model-"));
  tmpDirs.push(dir);
  return dir;
}

async function ctx(dir: string, overrides: Partial<ModelContext> = {}): Promise<ModelContext> {
  return { dir, file: "current.gguf", ...overrides };
}

function events() {
  const logs: Array<[string, string]> = [];
  const progress: unknown[] = [];
  return {
    logs,
    progress,
    impl: {
      log: (level: "info" | "warn" | "error", msg: string) => logs.push([level, msg]),
      progress: (p: unknown) => progress.push(p),
    },
  };
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("installModelFromFile", () => {
  it("installs and verifies checksum, cleaning staging", async () => {
    const dir = await makeTmp();
    const c = await ctx(dir);
    const source = path.join(dir, "source.gguf");
    await writeFile(source, "model-bytes");
    c.sha256 = await sha256Of(Buffer.from("model-bytes"));
    const e = events();

    await installModelFromFile(c, { source, events: e.impl });

    const target = path.join(dir, "current.gguf");
    await expect(readFile(target, "utf8")).resolves.toBe("model-bytes");
    await expect(stat(path.join(dir, ".download"))).rejects.toThrow();
    expect(e.logs.some(([l]) => l === "info")).toBe(true);
  });

  it("aborts on checksum mismatch and leaves no artifacts", async () => {
    const dir = await makeTmp();
    const c = await ctx(dir, { sha256: "00".repeat(32) });
    const source = path.join(dir, "source.gguf");
    await writeFile(source, "other-bytes");
    const e = events();

    await expect(installModelFromFile(c, { source, events: e.impl })).rejects.toThrow(
      "model checksum mismatch"
    );
    await expect(stat(path.join(dir, "current.gguf"))).rejects.toThrow();
    await expect(stat(path.join(dir, ".download"))).rejects.toThrow();
  });

  it("installs without a configured checksum", async () => {
    const dir = await makeTmp();
    const c = await ctx(dir);
    const source = path.join(dir, "source.gguf");
    await writeFile(source, "bare");
    const e = events();

    await installModelFromFile(c, { source, events: e.impl });

    await expect(readFile(path.join(dir, "current.gguf"), "utf8")).resolves.toBe("bare");
  });
});

describe("updateModelAction", () => {
  it("downloads through fetch, verifies, swaps, and reports progress", async () => {
    const dir = await makeTmp();
    const payload = Buffer.from("llama-gguf-payload");
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(payload, { headers: { "content-length": String(payload.byteLength) } })
    );
    const c = await ctx(dir, {
      url: "https://example.com/model.gguf",
      sha256: sha256Of(payload),
    });
    const e = events();

    await updateModelAction({ ctx: c, events: e.impl, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(dir, "current.gguf"))).resolves.toEqual(payload);
    await expect(stat(path.join(dir, ".download"))).rejects.toThrow();
    const phases = (e.progress as Array<{ phase: string }>).map((p) => p.phase);
    expect(phases).toContain("downloading");
    expect(phases).toContain("swapping");
    const lastDownload = (e.progress as Array<{ phase: string; percent?: number }>)
      .filter((p) => p.phase === "downloading")
      .at(-1);
    expect(lastDownload?.percent).toBe(100);
  });

  it("fails without a model url", async () => {
    const dir = await makeTmp();
    const c = await ctx(dir);
    const e = events();
    await expect(updateModelAction({ ctx: c, events: e.impl })).rejects.toThrow("MODEL_URL");
  });

  it("propagates download failures", async () => {
    const dir = await makeTmp();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    const c = await ctx(dir, { url: "https://example.com/model.gguf" });
    const e = events();
    await expect(updateModelAction({ ctx: c, events: e.impl, fetchImpl })).rejects.toThrow(
      "HTTP 500"
    );
    await expect(stat(path.join(dir, ".download"))).rejects.toThrow();
  });
});

describe("ensureModelAction", () => {
  it("skips download when the model is present", async () => {
    const dir = await makeTmp();
    await writeFile(path.join(dir, "current.gguf"), "present");
    const fetchImpl = vi.fn();
    const c = await ctx(dir, { url: "https://example.com/model.gguf" });
    const e = events();

    await ensureModelAction({ ctx: c, events: e.impl, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(path.join(dir, "current.gguf"), "utf8")).resolves.toBe("present");
  });

  it("downloads when missing and url is set", async () => {
    const dir = await makeTmp();
    const payload = Buffer.from("download-me");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(payload, { headers: { "content-length": String(payload.byteLength) } }));
    const c = await ctx(dir, {
      url: "https://example.com/model.gguf",
      sha256: sha256Of(payload),
    });
    const e = events();

    await ensureModelAction({ ctx: c, events: e.impl, fetchImpl });

    await expect(readFile(path.join(dir, "current.gguf"))).resolves.toEqual(payload);
  });

  it("warns and leaves unprovisioned when missing and url is unset", async () => {
    const dir = await makeTmp();
    const fetchImpl = vi.fn();
    const c = await ctx(dir);
    const e = events();

    await ensureModelAction({ ctx: c, events: e.impl, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(e.logs.some(([level, msg]) => level === "warn" && msg.includes("MODEL_URL"))).toBe(true);
  });
});
