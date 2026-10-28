import { useEffect, useState, type ReactNode } from "react";
import { api, pickFolder, type AiStatus } from "../db/api";
import ApiKeyField from "../app/ApiKeyField";
import { SETTINGS, getJson, setJson } from "../app/settings";
import { SHORTCUTS } from "../app/shortcuts";
import { Badge, Button, Panel } from "../app/ui";
import TaxonomyEditor from "../ideas/TaxonomyEditor";
import { DEFAULT_TAXONOMY, type Taxonomy } from "../ideas/taxonomy";
import { PRESETS, allPresets, parseTypeLines, renderFilename, slugify, typeLines, validatePreset, type NamingPreset } from "../library/renameEngine";
import { PLATFORMS, type PlatformId } from "../thumbnails/platforms";
import { DEFAULT_WEIGHTS, type Weights } from "../thumbnails/score";
import WeightsEditor from "../thumbnails/WeightsEditor";

/** Every saved preference in one place. Each section saves on its own button; nothing touches files. */
export default function SettingsPage({ onRunSetup }: { onRunSetup: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [custom, setCustom] = useState<NamingPreset[]>([]);
  const [platform, setPlatform] = useState<PlatformId>("youtube");
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [projectsDir, setProjectsDir] = useState<string | null>(null);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>(DEFAULT_TAXONOMY);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLibraryRoot(await api.getSetting(SETTINGS.libraryRoot));
      setPresetId((await api.getSetting(SETTINGS.libraryPreset)) ?? PRESETS[0].id);
      setCustom(await getJson<NamingPreset[]>(SETTINGS.customPresets, []));
      setPlatform(((await api.getSetting(SETTINGS.defaultPlatform)) as PlatformId | null) ?? "youtube");
      setWeights({ ...DEFAULT_WEIGHTS, ...(await getJson<Partial<Weights>>(SETTINGS.weights, {})) });
      setProjectsDir(await api.getSetting(SETTINGS.projectsDir));
      setTaxonomy({ ...DEFAULT_TAXONOMY, ...(await getJson<Partial<Taxonomy>>(SETTINGS.taxonomy, {})) });
      setAi(await api.aiStatus());
      setLoaded(true);
    })().catch((e) => setError(String(e)));
  }, []);

  async function save(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setSaved(what);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  const presets = allPresets(custom);

  async function saveCustom(next: NamingPreset[], what: string) {
    await save(what, () => setJson(SETTINGS.customPresets, next));
    setCustom(next);
    if (!allPresets(next).some((p) => p.id === presetId)) {
      setPresetId(PRESETS[0].id);
      await api.setSetting(SETTINGS.libraryPreset, PRESETS[0].id);
    }
  }

  if (!loaded) return <div className="p-6 text-sm text-muted">{error ?? "Loading settings…"}</div>;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Settings</h1>
        <span className="flex items-center gap-3">
          {saved && <span className="text-xs text-ok">Saved: {saved}</span>}
          <Button onClick={onRunSetup}>Run first-run setup again</Button>
        </span>
      </div>
      {error && <div className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

      <Panel title="Media library">
        <div className="space-y-4 p-4">
          <Row label="Media folder" hint="Opened (and rescanned, read-only) when you visit the Media library.">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{libraryRoot ?? "Not set"}</span>
            <Button
              onClick={async () => {
                const dir = await pickFolder("Choose your main media folder");
                if (dir) await save("media folder", async () => { await api.setSetting(SETTINGS.libraryRoot, dir); setLibraryRoot(dir); });
              }}
            >
              {libraryRoot ? "Change…" : "Choose…"}
            </Button>
          </Row>
          <Row label="Default naming preset">
            <select
              className="rounded-md border border-line bg-panel px-2 py-1.5 text-sm"
              value={presetId}
              onChange={(e) => {
                const id = e.target.value;
                setPresetId(id);
                save("default naming preset", () => api.setSetting(SETTINGS.libraryPreset, id));
              }}
              aria-label="Default naming preset"
            >
              {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Row>
          <PresetManager
            presets={presets}
            custom={custom}
            onSave={(p) => saveCustom(custom.some((c) => c.id === p.id) ? custom.map((c) => (c.id === p.id ? p : c)) : [...custom, p], `preset "${p.label}"`)}
            onRemove={(id) => saveCustom(custom.filter((c) => c.id !== id), "preset removed")}
          />
        </div>
      </Panel>

      <Panel title="Thumbnail tester">
        <div className="space-y-4 p-4">
          <Row label="Default platform" hint="For projects that haven't picked one yet.">
            <div className="flex rounded-md border border-line p-0.5">
              {(Object.keys(PLATFORMS) as PlatformId[]).map((p) => (
                <button
                  key={p}
                  onClick={() => save("default platform", async () => { await api.setSetting(SETTINGS.defaultPlatform, p); setPlatform(p); })}
                  className={`rounded px-2.5 py-1 text-sm ${platform === p ? "bg-accent text-accent-ink" : "hover:bg-sunken"}`}
                  aria-pressed={platform === p}
                >
                  {PLATFORMS[p].label}
                </button>
              ))}
            </div>
          </Row>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Scoring weights (points)</h3>
            <WeightsEditor weights={weights} onWeights={(w) => save("weights", async () => { await setJson(SETTINGS.weights, w); setWeights(w); })} />
          </div>
        </div>
      </Panel>

      <Panel title="Idea organizer">
        <div className="space-y-4 p-4">
          <Row label="Projects folder" hint="Each project becomes <date>_<title>/ in here.">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{projectsDir ?? "Not set"}</span>
            <Button
              onClick={async () => {
                const dir = await pickFolder("Choose (or create) your Projects folder", "C:\\Demo\\Projects");
                if (dir) await save("Projects folder", async () => { await api.setSetting(SETTINGS.projectsDir, dir); setProjectsDir(dir); });
              }}
            >
              {projectsDir ? "Change…" : "Choose…"}
            </Button>
          </Row>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Categories</h3>
            <TaxonomyEditor taxonomy={taxonomy} onTaxonomy={(t) => save("categories", async () => { await setJson(SETTINGS.taxonomy, t); setTaxonomy(t); })} />
          </div>
        </div>
      </Panel>

      <Panel title="Claude" actions={ai && <Badge tone={ai.configured ? "ok" : "muted"}>{ai.configured ? `On (${ai.source === "env" ? "ANTHROPIC_API_KEY" : "keychain"})` : "Off"}</Badge>}>
        <div className="p-4">
          <p className="mb-2 text-sm text-muted">Used for the thumbnail hook critique and idea categorization, only when you ask and after you confirm what is sent. Model: {ai?.model}.</p>
          <ApiKeyField ai={ai} onAi={setAi} offlineNote="Without a key, every other feature works offline." />
        </div>
      </Panel>

      <Panel title="Keyboard shortcuts">
        <dl className="grid gap-x-6 px-4 py-3 text-sm md:grid-cols-2">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex justify-between gap-4 py-1">
              <dt className="shrink-0 font-mono text-xs">{s.keys}</dt>
              <dd className="text-right text-muted">{s.what}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="w-44 shrink-0 text-sm font-medium">{label}</span>
        <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      </div>
      {hint && <p className="ml-44 pl-3 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function PresetManager({ presets, custom, onSave, onRemove }: { presets: NamingPreset[]; custom: NamingPreset[]; onSave: (p: NamingPreset) => void; onRemove: (id: string) => void }) {
  const [editing, setEditing] = useState<NamingPreset | null>(null);
  const [label, setLabel] = useState("");
  const [pattern, setPattern] = useState("");
  const [types, setTypes] = useState("");

  function open(p: NamingPreset, asCopy: boolean) {
    setEditing(asCopy ? { ...p, id: "" } : p);
    setLabel(asCopy ? `${p.label} (custom)` : p.label);
    setPattern(p.pattern);
    setTypes(typeLines(p));
  }

  const parsed = parseTypeLines(types);
  const draft: NamingPreset | null = editing && { id: editing.id || `custom-${slugify(label) || "preset"}-${Date.now().toString(36)}`, label: label.trim(), pattern: pattern.trim(), ...parsed };
  const problems = draft ? validatePreset(draft) : [];
  const example = draft && !problems.length ? renderFilename(draft.pattern, { date: "2026-10-27", slug: "leg day", type: draft.types[0] }, 1, "mp4") : null;

  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Naming presets</h3>
      <ul className="divide-y divide-line rounded-md border border-line">
        {presets.map((p) => {
          const own = custom.some((c) => c.id === p.id);
          return (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="w-40 shrink-0 font-medium">{p.label}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{p.pattern} · {p.types.join(", ")}</code>
              {!own && <Badge>built-in</Badge>}
              {own && <Button variant="ghost" className="!py-0.5 text-xs" onClick={() => open(p, false)}>Edit</Button>}
              <Button variant="ghost" className="!py-0.5 text-xs" onClick={() => open(p, true)}>Duplicate</Button>
              {own && <Button variant="ghost" className="!py-0.5 text-xs" onClick={() => onRemove(p.id)} title="Removes the preset only. Files keep their names.">Remove</Button>}
            </li>
          );
        })}
      </ul>
      {editing && draft && (
        <div className="mt-2 space-y-2 rounded-md border border-line p-3">
          <label className="block text-xs font-medium text-muted">
            Name
            <input className="mt-1 w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Pattern ({"{date} {slug} {type} {version}"}; the extension is added automatically)
            <input className="mt-1 w-full rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-sm" value={pattern} onChange={(e) => setPattern(e.target.value)} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Content types, one per line as <code>type: Folder</code> (the folder used by “Sort into type folders”)
            <textarea className="mt-1 h-28 w-full rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-sm" value={types} onChange={(e) => setTypes(e.target.value)} />
          </label>
          {problems.length > 0 ? (
            <ul className="text-xs text-danger">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          ) : (
            <p className="text-xs text-muted">e.g. <code className="font-mono text-ink">{example}</code></p>
          )}
          <div className="flex gap-2">
            <Button variant="primary" disabled={problems.length > 0} onClick={() => { onSave(draft); setEditing(null); }}>Save preset</Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
