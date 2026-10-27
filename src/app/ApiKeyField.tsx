import { useState } from "react";
import { api, type AiStatus } from "../db/api";
import { Button } from "./ui";

/** Anthropic API key entry. The key goes straight to the OS keychain via Rust. */
export default function ApiKeyField({ ai, onAi, offlineNote }: { ai: AiStatus | null; onAi: (s: AiStatus) => void; offlineNote: string }) {
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function saveKey() {
    try {
      onAi(await api.setApiKey(key));
      setKey("");
      setMsg("Saved to the system keychain.");
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <>
      {ai?.source === "env" ? (
        <p className="text-sm">Using the ANTHROPIC_API_KEY environment variable.</p>
      ) : (
        <>
          <div className="flex gap-2">
            <input type="password" autoComplete="off" className="flex-1 rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-sm" placeholder={ai?.configured ? "Key saved. Paste to replace." : "sk-ant-…"} value={key} onChange={(e) => setKey(e.target.value)} aria-label="Anthropic API key" />
            <Button onClick={saveKey} disabled={!key.trim()}>Save</Button>
            {ai?.configured && <Button variant="ghost" onClick={async () => onAi(await api.clearApiKey())}>Remove</Button>}
          </div>
          <p className="mt-2 text-xs text-muted">Stored in your OS keychain, never in the app database or this window. {offlineNote}</p>
        </>
      )}
      {msg && <p className="mt-2 text-xs">{msg}</p>}
    </>
  );
}
