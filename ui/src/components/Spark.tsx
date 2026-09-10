import { useEffect, useRef } from "react";
import { usePageVisible } from "../lib/useFrame";

export function Spark({ data, color, max, height = 52, fill = true }: { data: (number | null)[]; color?: string; max?: number; height?: number; fill?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const visible = usePageVisible();

  useEffect(() => {
    if (!visible) return;
    const cvs = ref.current;
    if (!cvs) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cvs.clientWidth || 200;
    const h = cvs.clientHeight || height;
    cvs.width = Math.round(w * dpr);
    cvs.height = Math.round(h * dpr);
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const m = max ?? Math.max(...data.map((v) => v ?? 0), 1);
    const pts = data.map((v, i) => ({
      x: (i / Math.max(1, data.length - 1)) * w,
      y: h - (v == null ? 0 : Math.min(1, v / m)) * (h - 4) - 2,
    }));
    if (color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (p.y > h) continue;
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      if (fill && started) {
        ctx.lineTo(pts[pts.length - 1]?.x ?? w, h);
        ctx.lineTo(pts[0]?.x ?? 0, h);
        ctx.closePath();
        const rg = ctx.createLinearGradient(0, 0, 0, h);
        rg.addColorStop(0, colorWithAlpha(color));
        rg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = rg;
        ctx.fill();
      }
    }
  }, [data, color, max, height, visible]);

  return <canvas ref={ref} className="spark" style={{ height: height + "px" }} />;
}

function colorWithAlpha(c: string): string {
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(c.trim());
  if (m) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
    const rgb = v.split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
    if (rgb.length >= 3) return "rgba(" + rgb.slice(0, 3).join(",") + ",0.34)";
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.slice(0, 7) + "55";
    return v;
  }
  if (c.startsWith("#")) return c.length >= 7 ? c.slice(0, 7) + "55" : c;
  return c;
}