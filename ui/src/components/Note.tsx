import { useEffect, useState } from "react";

export function Note({ id }: { id: string }) {
  const key = "pipenote-" + id;
  const [val, setVal] = useState<string>(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(key, val);
      } catch {}
    }, 400);
    return () => clearTimeout(t);
  }, [val, key]);
  return (
    <textarea
      className="pnote"
      placeholder="Note (optional)"
      value={val}
      onChange={(e) => setVal(e.target.value)}
    />
  );
}