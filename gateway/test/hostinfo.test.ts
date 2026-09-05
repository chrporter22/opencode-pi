import { describe, expect, it } from "vitest";
import { readHostInfo } from "../src/hostinfo.js";

describe("readHostInfo", () => {
  it("returns the container-visible host details", () => {
    const info = readHostInfo();
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(info.os.length).toBeGreaterThan(0);
    expect(info.kernel.length).toBeGreaterThan(0);
    expect(info.arch.length).toBeGreaterThan(0);
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(info.cpuCores).toBeGreaterThan(0);
    expect(info.cpuModel.length).toBeGreaterThan(0);
    expect(info.memoryTotalBytes).toBeGreaterThan(0);
  });
});