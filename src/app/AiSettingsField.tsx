import { useEffect, useState } from "react";
import { api, type AiProviderId, type AiStatus } from "../db/api";
import { Button } from "./ui";

/** Short status for panel badges, e.g. "AI on: OpenRouter (keychain)". */
export function aiBadgeText(ai: AiStatus): string {
  if (!ai.configured) return `AI off (no ${ai.providerLabel} key)`;
  return `AI on: ${ai.providerLabel} (${ai.source === "env" ? ai.providers.find((p) => p.id === ai.provider)?.envVar : "keychain"})`;
}

/** Where a request goes, for consent dialogs. */
export function aiDestination(ai: AiStatus | null): string {
  if (!ai) return "the AI provider";
  return ai.provider === "openrouter"
    ? `OpenRouter (model ${ai.model}; routed only to providers that don't keep or train on prompts)`
    : `Anthropic's API (${ai.model})`;
}

const PROVIDERS: Array<{ id: AiProviderId; label: string; hint: string }> = [
  { id: "anthropic", label: "Anthropic API", hint: "Claude directly. Key from console.anthropic.com (starts with sk-ant-)." },
  { id: "openrouter", label: "OpenRouter", hint: "Claude or another model through openrouter.ai, billed to your OpenRouter credits." },
];

/**
 * Provider choice, OpenRouter model, and the API key for the chosen provider. Keys go straight
 * to the OS keychain via Rust and are never shown again.
 */
export default function AiSettingsField({ ai, onAi, offlineNote }: { ai: AiStatus | null; onAi: (s: AiStatus) => void; offlineNote: string }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(ai?.provider === "openrouter" ? ai.model : "");
  const [msg, setMsg] = useState<string | null>(null);
  const current = ai?.providers.find((p) => p.id === ai.provider);

  useEffect(() => {
    if (ai?.provider === "openrouter") setModel(ai.model);
  }, [ai?.provider, ai?.model]);

  async function run(fn: () => Promise<AiStatus>, ok: string) {
    try {
      onAi(await fn());
      setMsg(ok);
    } catch (e) {
      setMsg(String(e));
    }
  }

  if (!ai) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-2">
      <div className="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="AI provider">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={ai.provider === p.id}
            onClick={() => ai.provider !== p.id && run(() => api.setAiProvider(p.id, null), `Using ${p.label}.`)}
            className={`flex-1 rounded px-2.5 py-1 text-sm ${ai.provider === p.id ? "bg-accent text-accent-ink" : "hover:bg-sunken"}`}
          >
            {p.label}
            {ai.providers.find((x) => x.id === p.id)?.configured && <span className="ml-1 text-[10px] opacity-80">· key saved</span>}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{PROVIDERS.find((p) => p.id === ai.provider)?.hint}</p>

      {ai.provider === "openrouter" && (
        <label className="block text-xs font-medium text-muted">
          Model (OpenRouter id; must accept images and structured output)
          <span className="mt-1 flex gap-2">
            <input className="flex-1 rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-sm" value={model} onChange={(e) => setModel(e.target.value)} aria-label="OpenRouter model" />
            <Button onClick={() => run(() => api.setAiProvider("openrouter", model), `Model set to ${model.trim()}.`)} disabled={!model.trim() || model.trim() === ai.model}>Use model</Button>
          </span>
        </label>
      )}

      {current?.source === "env" ? (
        <p className="text-sm">Using the {current.envVar} environment variable.</p>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              className="flex-1 rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-sm"
              placeholder={current?.configured ? "Key saved. Paste to replace." : ai.provider === "anthropic" ? "sk-ant-…" : "OpenRouter API key"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-label={`${ai.providerLabel} API key`}
            />
            <Button onClick={() => run(async () => { const s = await api.setApiKey(ai.provider, key); setKey(""); return s; }, "Saved to the system keychain.")} disabled={!key.trim()}>Save</Button>
            {current?.configured && <Button variant="ghost" onClick={() => run(() => api.clearApiKey(ai.provider), "Key removed.")}>Remove</Button>}
          </div>
          <p className="text-xs text-muted">Stored in your OS keychain, never in the app database or this window. Or set {current?.envVar}. {offlineNote}</p>
        </>
      )}
      {msg && <p className="text-xs">{msg}</p>}
    </div>
  );
}
