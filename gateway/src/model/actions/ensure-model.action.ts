import { stat } from "node:fs/promises";
import type { ModelContext, ModelEvents } from "../types.js";
import { updateModelAction } from "./update-model.action.js";

export interface EnsureModelInput {
  ctx: ModelContext;
  events: ModelEvents;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function ensureModelAction(opts: EnsureModelInput): Promise<void> {
  const { ctx, events } = opts;
  const target = `${ctx.dir}/${ctx.file}`;
  let present = false;
  try {
    const st = await stat(target);
    present = st.size > 0;
  } catch {
    present = false;
  }

  if (present) {
    events.log("info", "Model already present, skipping download");
    return;
  }
  if (!ctx.url) {
    events.log("warn", "Model missing and MODEL_URL not set; leaving it unprovisioned");
    return;
  }

  await updateModelAction({ ctx, url: ctx.url, events, fetchImpl: opts.fetchImpl, signal: opts.signal });
}