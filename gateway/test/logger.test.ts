import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

describe("logger", () => {
  it("keeps entries in order within the ring bound", () => {
    const log = createLogger({ maxEntries: 3 });
    log.info("a");
    log.info("b");
    log.info("c");
    log.info("d");
    log.info("e");
    const snap = log.snapshot();
    expect(snap.map((e) => e.msg)).toEqual(["c", "d", "e"]);
  });

  it("filters by minLevel", () => {
    const log = createLogger({ minLevel: "warn" });
    log.info("hidden");
    log.warn("shown");
    log.error("boom");
    expect(log.snapshot().map((e) => e.msg)).toEqual(["shown", "boom"]);
  });

  it("records level on each entry", () => {
    const log = createLogger();
    log.debug("d");
    const entry = log.snapshot()[0];
    expect(entry.level).toBe("debug");
    expect(typeof entry.ts).toBe("number");
  });

  it("notifies subscribers and supports unsubscribe", () => {
    const log = createLogger();
    const seen: string[] = [];
    const unsub = log.subscribe((entry) => seen.push(entry.msg));
    log.info("one");
    unsub();
    log.info("two");
    expect(seen).toEqual(["one"]);
  });
});