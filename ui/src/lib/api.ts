import { localKey } from "../store/ui";

const ADMIN = "x-api-key";

function clearKey(k: string) {
  try {
    localStorage.removeItem(k);
  } catch {}
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; admin?: boolean; raw?: boolean } = {}): Promise<T> {
  const key = localKey();
  if (!key) throw new Error("missing key");
  const headers: Record<string, string> = { [ADMIN]: key };
  if (opts.body != null) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 401) {
      clearKey("adminKey");
      throw new Error("unauthorized (admin key)");
    }
    let detail = await res.text().catch(() => "");
    if (!detail) detail = res.status + " " + res.statusText;
    if (detail.length > 300) detail = detail.slice(0, 300);
    throw new Error(detail);
  }
  if (opts.raw) return (await res.text()) as unknown as T;
  return (await res.json().catch(() => ({}))) as T;
}

export async function getHealth(): Promise<{ ok?: boolean; message?: string } | null> {
  try {
    const res = await fetch("/health");
    return await res.json();
  } catch {
    return null;
  }
}

export async function inferenceGet<T>(path: string, key: string): Promise<T> {
  const res = await fetch(path, { headers: { Authorization: "Bearer " + key } });
  if (!res.ok) throw new Error(res.status + " " + res.statusText);
  return (await res.json()) as T;
}