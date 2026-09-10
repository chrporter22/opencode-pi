import { useEffect, useRef, useState } from "react";

export function useFrame(fn: (dt: number, t: number) => void, active: boolean): void {
  const cbRef = useRef(fn);
  cbRef.current = fn;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(100, t - last);
      last = t;
      try {
        cbRef.current(dt, t);
      } finally {
        raf = requestAnimationFrame(loop);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

export function usePageVisible(): boolean {
  const [vis, setVis] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setVis(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return vis;
}

// Coalesces calls within one animation frame — used for hot WS paths so a burst
// of samples triggers at most one store update (and one render) per frame.
let batchQueue: Array<() => void> = [];
let batchScheduled = false;

export function rafBatch(fn: () => void): void {
  batchQueue.push(fn);
  if (batchScheduled) return;
  batchScheduled = true;
  requestAnimationFrame(() => {
    batchScheduled = false;
    const q = batchQueue;
    batchQueue = [];
    for (const f of q) f();
  });
}

// Interval that only runs while the tab is visible; runtime resumed on return.
export function useVisibleInterval(fn: () => void, ms: number, active = true): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const visible = usePageVisible();
  useEffect(() => {
    if (!active || !visible) return;
    fnRef.current();
    const id = window.setInterval(() => fnRef.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, active, visible]);
}