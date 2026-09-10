// Deterministic transpile of the legacy optional "viridis" theme preset.
export const VIRIDIS: [number, number, number][] = [
  [68, 1, 84], [72, 35, 116], [64, 67, 135], [52, 94, 141], [41, 120, 142],
  [33, 145, 140], [34, 168, 132], [68, 190, 112], [105, 206, 88], [157, 219, 50],
  [253, 231, 37],
];

export function parseHex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function quantizeBuckets<T>(values: T[], nb: number): T[] {
  const q: T[] = [];
  for (let i = 0; i < nb; i++) {
    const k = Math.max(1, (i / nb) * values.length);
    const idx = Math.min(values.length - 1, Math.floor(k));
    q.push(values[idx]);
  }
  return q;
}

export function shortLabel(featureName: string): string {
  return featureName.replace(/^request\.|^ctx\.|^toggle\.|^time\./, "");
}

export function qnt(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(1) + "σ";
}

export function pDelimited(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 5 });
}

