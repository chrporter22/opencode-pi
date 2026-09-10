import { useEffect, useRef, useState } from "react";
import { useStoreSlice } from "../store/core";
import { uiStore } from "../store/ui";
import { Card } from "./ui";

interface Bubble {
  role: "user" | "assistant";
  text: string;
}

export function Playground() {
  const iKey = useStoreSlice(uiStore, (s) => s.inferenceKey);
  const [msgs, setMsgs] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const convoRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = convoRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  async function send(text: string) {
    if (!text.trim()) return;
    if (!iKey) {
      alert("Enter the inference API key to use the playground.");
      return;
    }
    const next: Bubble[] = [...msgs, { role: "user", text }];
    setMsgs([...next, { role: "assistant", text: "" }]);
    setInput("");
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const r = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + iKey, "x-opencode-pi-source": "playground" },
        body: JSON.stringify({ model: "Qwen2.5-Coder-3B-Instruct", stream: true, messages: convoOf(next) }),
        signal: abort.signal,
      });
      if (!r.ok || !r.body) throw new Error("HTTP " + (r.status || 0));
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data) as { choices?: { delta?: Record<string, string | undefined> }[] };
            const delta = j.choices?.[0]?.delta ?? {};
            const piece = delta.content ?? delta.reasoning_content ?? "";
            if (piece) {
              full += piece;
              setMsgs([...next, { role: "assistant", text: full }]);
            }
          } catch {}
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        setMsgs((cur) => {
          const last = cur[cur.length - 1];
          if (last && last.role === "assistant" && last.text === "") {
            return [...cur.slice(0, -1), { ...last, text: "stopped" }];
          }
          return cur;
        });
      } else {
        setMsgs([...next, { role: "assistant", text: "error: " + err.message }]);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="grid gap-4 grid-cols-1">
      <Card cls="ac-pg" title="Playground">
        <div className="flex flex-col gap-2 max-h-[70vh] overflow-y-auto" ref={convoRef}>
          {msgs.length === 0 ? (
            <div className="msg assistant hint">Send a message to start a conversation through /v1/chat/completions.</div>
          ) : null}
          {msgs.map((m, i) => (
            <div key={i} className={"msg " + m.role}>{m.text}</div>
          ))}
        </div>
        <input
          id="chatInput"
          className="w-full mt-3 bg-input border border-border rounded-md px-3 py-2 text-[13px] text-fg"
          placeholder="Message the model…"
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="row actions" style={{ paddingTop: 4 }}>
          <button className="btn" disabled={busy} onClick={() => void send(input)}>Send</button>
          <button className="btn-ghost" disabled={!busy} onClick={() => { abortRef.current?.abort(); }}>Stop</button>
        </div>
      </Card>
    </div>
  );
}

function convoOf(msgs: Bubble[]): { role: string; content: string }[] {
  return msgs.map((m) => ({ role: m.role, content: m.text }));
}