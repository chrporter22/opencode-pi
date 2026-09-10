import { describe, expect, it } from "vitest";
import { chipState, escapeHtml, fmtBytes, fmtUptime, lastNum, nnTxt } from "./fmt";
import { lerp, shortLabel } from "./math";

describe("fmt", () => {
  it("fmtBytes", () => {
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes(1024)).toBe("1 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(fmtBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
  });
  it("fmtUptime", () => {
    expect(fmtUptime(undefined)).toBe("—");
    expect(fmtUptime(3665)).toBe("1h 1m");
    expect(fmtUptime(90061)).toBe("1d 1h 1m");
  });
  it("escapeHtml", () => {
    expect(escapeHtml(`<b>"x"&'y'</b>`)).toBe("&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;");
  });
  it("chipState", () => {
    expect(chipState("online")).toBe("ok");
    expect(chipState("error")).toBe("err");
    expect(chipState("unknown")).toBe("warn");
    expect(chipState("—")).toBe(null);
  });
  it("lastNum", () => {
    expect(lastNum([])).toBe(null);
    expect(lastNum([null, 2, undefined, 4])).toBe(4);
  });
  it("nnTxt secondary prob ≥ 10%", () => {
    expect(nnTxt()).toBe("—");
    expect(nnTxt("high", [0.05, 0.2, 0.75])).toBe("high 75% · watch 20%");
    expect(nnTxt("normal", [0.9, 0.05, 0.05])).toBe("normal 90%");
  });
});

describe("math", () => {
  it("lerp", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });
  it("shortLabel", () => {
    expect(shortLabel("request.p95")).toBe("p95");
    expect(shortLabel("cpu")).toBe("cpu");
  });
});