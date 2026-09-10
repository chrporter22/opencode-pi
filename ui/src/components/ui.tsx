import type { ReactNode } from "react";

export function Card({ title, cls, children, id }: { title?: string; cls?: string; children: ReactNode; id?: string }) {
  return (
    <div className={"card " + (cls ?? "")} data-id={id}>
      {title ? <h2>{title}</h2> : null}
      {children}
    </div>
  );
}

export function Row({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className={mono ? "mono" : ""}>{v}</span>
    </div>
  );
}

export function Chip({ state, children, title }: { state?: "ok" | "err" | "warn" | "pending" | null; children: ReactNode; title?: string }) {
  return (
    <span className={"chip " + (state ?? "")} title={title}>
      {children}
    </span>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="muted">{children}</span>;
}