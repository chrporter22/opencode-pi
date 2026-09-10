import { useMemo, useState } from "react";
import { useStoreSlice } from "../store/core";
import { opsStore } from "../store/ops";
import { Card } from "./ui";

type LevelF = "all" | "error" | "warn";
type SourceF = "all" | "ml" | "req" | "sys";

export function Logs() {
  const logs = useStoreSlice(opsStore, (s) => s.logs);
  const [level, setLevel] = useState<LevelF>("all");
  const [source, setSource] = useState<SourceF>("all");
  const [cleared, setCleared] = useState(false);

  const shown = useMemo(() => {
    if (cleared) return [];
    return logs.filter((l) => {
      if (level === "error" && l.level !== "error") return false;
      if (level === "warn" && l.level !== "warn" && l.level !== "error") return false;
      if (source === "ml" && !/training|trial|epoch|f1|watermark|tf-lite|tflite|analytics/i.test(l.msg)) return false;
      if (source === "req" && !/request|llama|model|v1\/chat/i.test(l.msg)) return false;
      if (source === "sys" && /training|trial|epoch|f1|watermark|tf-lite|tflite|analytics|request|llama/i.test(l.msg)) return false;
      return true;
    });
  }, [logs, level, source, cleared]);

  return (
    <div className="grid gap-4 grid-cols-1">
      <Card cls="ac-evt" title="Event log">
        <div className="row actions">
          <button className="btn-mini" onClick={() => setCleared(true)}>Clear</button>
        </div>
        <div className="filter-bar" data-log-filters>
          <button className={level === "all" ? "active" : ""} onClick={() => setLevel("all")}>All</button>
          <button className={level === "error" ? "active" : ""} onClick={() => setLevel("error")}>Errors</button>
          <button className={level === "warn" ? "active" : ""} onClick={() => setLevel("warn")}>Warn+</button>
          <span className="f-sep" />
          <button className={source === "all" ? "active" : ""} onClick={() => setSource("all")}>All sources</button>
          <button className={source === "ml" ? "active" : ""} onClick={() => setSource("ml")}>ML</button>
          <button className={source === "req" ? "active" : ""} onClick={() => setSource("req")}>Requests</button>
          <button className={source === "sys" ? "active" : ""} onClick={() => setSource("sys")}>System</button>
        </div>
        <div className="log" style={{ maxHeight: 540 }} data-log>
          {shown.map((e, i) => (
            <div key={"logs-" + e.ts + "-" + i} className="evt">
              <span className="t">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={"tag " + (e.level === "error" ? "err" : e.level === "warn" ? "warn" : "info")}>{e.level}</span>
              <span className="msg">{e.msg}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}