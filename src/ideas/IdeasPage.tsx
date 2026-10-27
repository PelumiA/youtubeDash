import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, pickFolder, type AiStatus, type Idea, type IdeaPatch, type IdeaStatus, type ScaffoldPlan, type ScaffoldRequest } from "../db/api";
import { Badge, Button, ConfirmDialog, Panel } from "../app/ui";
import ApiKeyField from "../app/ApiKeyField";
import { bytesToBase64 } from "../app/base64";
import { decode, ocrPaths, toCanvas } from "../thumbnails/browserAnalyze";
import { ocrWorker } from "../thumbnails/ocr";
import { readText } from "./ocrImage";
import { DEFAULT_TAXONOMY, TAXONOMY_PRESETS, localDate, parseCategories, parseTags, suggestLocally, titleFromText, type Suggestion, type Taxonomy } from "./taxonomy";

const TAXONOMY_KEY = "ideas.taxonomy";
const PROJECTS_DIR_KEY = "ideas.projectsDir";

type Tab = IdeaStatus | "all";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "project", label: "Projects" },
  { id: "archived", label: "Archived" },
  { id: "all", label: "All" },
];

async function readImageText(bytes: ArrayBuffer): Promise<string> {
  return readText(await ocrWorker(ocrPaths()), await decode(bytes), toCanvas);
}

const ideaText = (i: Idea) => [i.rawText, i.ocrText].map((s) => s?.trim()).filter(Boolean).join("\n\n");
const headline = (i: Idea) => i.title || (ideaText(i) ? titleFromText(ideaText(i)) : i.hasImage ? "Screenshot" : "Untitled idea");

export default function IdeasPage({ onOpenThumbnails }: { onOpenThumbnails?: () => void }) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("inbox");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [taxonomy, setTaxonomy] = useState<Taxonomy>(DEFAULT_TAXONOMY);
  const [projectsDir, setProjectsDir] = useState<string | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [consented, setConsented] = useState(false);
  const [consentFor, setConsentFor] = useState<number | null>(null);
  const [ocrBusy, setOcrBusy] = useState<Set<number>>(new Set());
  const [aiBusy, setAiBusy] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ req: ScaffoldRequest; plan: ScaffoldPlan } | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Ideas whose title, category or tags the user edited: later suggestions don't overwrite them. */
  const touched = useRef(new Set<number>());
  const fileInput = useRef<HTMLInputElement>(null);

  const selected = ideas.find((i) => i.id === selectedId) ?? null;
  const visible = tab === "all" ? ideas : ideas.filter((i) => i.status === tab);
  const count = (s: Tab) => (s === "all" ? ideas.length : ideas.filter((i) => i.status === s).length);

  const upsert = (idea: Idea) => setIdeas((list) => (list.some((i) => i.id === idea.id) ? list.map((i) => (i.id === idea.id ? idea : i)) : [idea, ...list]));
  const mark = (set: typeof setOcrBusy, id: number, on: boolean) =>
    set((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const refresh = useCallback(async (q: string) => setIdeas(await api.listIdeas(q)), []);

  useEffect(() => {
    (async () => {
      const t = await api.getSetting(TAXONOMY_KEY);
      if (t) setTaxonomy({ ...DEFAULT_TAXONOMY, ...JSON.parse(t) });
      setProjectsDir(await api.getSetting(PROJECTS_DIR_KEY));
      setAi(await api.aiStatus());
    })().catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => refresh(query).catch((e) => setError(String(e))), query ? 200 : 0);
    return () => clearTimeout(t);
  }, [query, refresh]);

  async function applySuggestion(idea: Idea, s: Suggestion, force = false): Promise<Idea> {
    const apply = force || !touched.current.has(idea.id);
    const patch: IdeaPatch = { suggestion: s, ...(apply ? { title: s.title, category: s.category, tags: s.tags } : {}) };
    if (force) touched.current.delete(idea.id);
    const updated = await api.updateIdea(idea.id, patch);
    upsert(updated);
    return updated;
  }

  async function runClaude(id: number) {
    setConsentFor(null);
    setConsented(true);
    mark(setAiBusy, id, true);
    try {
      const withSuggestion = await api.categorizeIdea(id, taxonomy.categories);
      await applySuggestion(withSuggestion, withSuggestion.suggestion!);
    } catch (e) {
      setError(String(e));
    } finally {
      mark(setAiBusy, id, false);
    }
  }

  // Ideas captured before a suggestion existed (or whose capture was interrupted) get the
  // offline suggestion when opened.
  useEffect(() => {
    if (!selected || selected.status !== "inbox" || selected.suggestion || ocrBusy.has(selected.id) || !ideaText(selected)) return;
    applySuggestion(selected, suggestLocally(ideaText(selected), taxonomy.categories)).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.suggestion, ocrBusy]);

  function askClaude(id: number) {
    if (consented) runClaude(id);
    else setConsentFor(id);
  }

  /** Offline suggestion right away; Claude's too when the user has already allowed it this session. */
  async function afterCapture(idea: Idea) {
    const text = ideaText(idea);
    if (!text) return;
    const updated = await applySuggestion(idea, suggestLocally(text, taxonomy.categories));
    if (ai?.configured && consented) runClaude(updated.id);
  }

  async function captureText() {
    if (!draft.trim()) return;
    setError(null);
    try {
      const idea = await api.captureIdea(draft, null, null, "text");
      setDraft("");
      upsert(idea);
      setTab("inbox");
      setSelectedId(idea.id);
      await afterCapture(idea);
    } catch (e) {
      setError(String(e));
    }
  }

  async function captureImage(file: Blob, source: "image" | "clipboard") {
    if (!file.type.startsWith("image/")) return setError("That isn't an image. Paste or drop a screenshot (PNG, JPG, WebP).");
    setError(null);
    let id: number | null = null;
    try {
      const bytes = await file.arrayBuffer();
      const idea = await api.captureIdea(draft, null, bytesToBase64(bytes), source);
      id = idea.id;
      setDraft("");
      upsert(idea);
      setTab("inbox");
      setSelectedId(idea.id);
      mark(setOcrBusy, idea.id, true);
      const text = await readImageText(bytes);
      const withText = await api.updateIdea(idea.id, { ocrText: text });
      upsert(withText);
      mark(setOcrBusy, idea.id, false);
      await afterCapture(withText);
    } catch (e) {
      setError(String(e));
    } finally {
      if (id != null) mark(setOcrBusy, id, false);
    }
  }

  // Ctrl+V a screenshot anywhere on the page.
  const captureRef = useRef(captureImage);
  captureRef.current = captureImage;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile();
      if (!file) return;
      e.preventDefault();
      captureRef.current(file, "clipboard");
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    (async () => {
      for (const f of files) await captureImage(f, "image");
    })();
  }

  async function patch(idea: Idea, p: IdeaPatch, userEdit = true) {
    if (userEdit && (p.title !== undefined || p.category !== undefined || p.tags !== undefined)) touched.current.add(idea.id);
    try {
      upsert(await api.updateIdea(idea.id, p));
    } catch (e) {
      setError(String(e));
    }
  }

  async function setStatus(idea: Idea, status: "inbox" | "archived") {
    try {
      upsert(await api.setIdeaStatus(idea.id, status));
    } catch (e) {
      setError(String(e));
    }
  }

  async function chooseProjectsDir(): Promise<string | null> {
    const dir = await pickFolder("Choose (or create) your Projects folder", "C:\\Demo\\Projects");
    if (dir) {
      await api.setSetting(PROJECTS_DIR_KEY, dir);
      setProjectsDir(dir);
    }
    return dir;
  }

  async function startCreate(idea: Idea) {
    setError(null);
    const dir = projectsDir ?? (await chooseProjectsDir());
    if (!dir) return;
    const req: ScaffoldRequest = {
      ideaId: idea.id,
      projectsDir: dir,
      title: idea.title ?? "",
      category: idea.category ?? "",
      tags: idea.tags,
      date: localDate(),
      footer: taxonomy.footer,
    };
    try {
      setPending({ req, plan: await api.previewScaffold(req) });
    } catch (e) {
      setError(String(e));
    }
  }

  async function confirmCreate() {
    if (!pending) return;
    setCreating(true);
    try {
      const project = await api.scaffoldIdea(pending.req);
      setNotice(`Created ${project.folderPath}. The idea is ready to brief, and the project is waiting in the thumbnail tester.`);
      setPending(null);
      await refresh(query);
    } catch (e) {
      setError(String(e));
      setPending(null);
    } finally {
      setCreating(false);
    }
  }

  async function saveTaxonomy(t: Taxonomy) {
    await api.setSetting(TAXONOMY_KEY, JSON.stringify(t));
    setTaxonomy(t);
  }

  return (
    <div
      className="relative mx-auto max-w-6xl space-y-4 p-6"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Idea organizer</h1>
        <span className="text-xs text-muted">Screenshots are read on this computer. Nothing is sent anywhere unless you ask Claude.</span>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">
          <span>{notice}</span>
          <span className="flex shrink-0 gap-2">
            {onOpenThumbnails && <Button className="!py-0.5 text-xs" onClick={onOpenThumbnails}>Thumbnail tester →</Button>}
            <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
          </span>
        </div>
      )}

      <Panel title="Capture">
        <div className="space-y-2 p-3">
          <textarea
            className="h-20 w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm"
            placeholder="Type or paste an idea… or paste a screenshot (Ctrl+V) anywhere on this page, or drop an image here."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) captureText();
            }}
            aria-label="New idea"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={captureText} disabled={!draft.trim()}>Add to inbox</Button>
            <Button onClick={() => fileInput.current?.click()}>Add screenshot…</Button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                (async () => {
                  for (const f of files) await captureImage(f, "image");
                })();
              }}
            />
            <span className="text-xs text-muted">Ctrl+Enter adds typed text. Text typed above is kept with a screenshot you add next.</span>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel
          title={
            <span className="flex gap-1">
              {TABS.map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)} className={`rounded px-2 py-0.5 text-sm ${tab === t.id ? "bg-sunken font-semibold" : "font-normal text-muted hover:text-ink"}`}>
                  {t.label} <span className="tabular-nums text-muted">{count(t.id)}</span>
                </button>
              ))}
            </span>
          }
        >
          <div className="border-b border-line p-2">
            <input
              type="search"
              className="w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm"
              placeholder="Search ideas and projects: text, screenshot text, tags, category…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search ideas"
            />
          </div>
          {visible.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted">
              {query && ideas.length ? (
                <>
                  No matches here.{" "}
                  <button className="underline" onClick={() => setTab("all")}>{ideas.length} in All</button>
                </>
              ) : query ? "Nothing matches that search." : tab === "inbox" ? "Inbox zero. Capture an idea above." : "Nothing here yet."}
            </p>
          )}
          <ul className="max-h-[60vh] divide-y divide-line overflow-auto">
            {visible.map((i) => (
              <li key={i.id}>
                <button onClick={() => setSelectedId(i.id)} className={`block w-full px-3 py-2.5 text-left hover:bg-sunken ${i.id === selectedId ? "bg-sunken" : ""}`}>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{headline(i)}</span>
                    <span className="shrink-0 text-[11px] text-muted">{new Date(i.createdAt).toLocaleDateString()}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {i.hasImage && <Badge>screenshot</Badge>}
                    {ocrBusy.has(i.id) && <Badge tone="warn">reading text…</Badge>}
                    {i.category && <Badge tone="accent">{i.category}</Badge>}
                    {i.status === "project" && <Badge tone="ok">ready to brief</Badge>}
                    {i.status === "archived" && <Badge>archived</Badge>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        {selected ? (
          <IdeaDetail
            key={`${selected.id}:${selected.updatedAt}`}
            idea={selected}
            categories={taxonomy.categories}
            ocrBusy={ocrBusy.has(selected.id)}
            aiBusy={aiBusy.has(selected.id)}
            ai={ai}
            onPatch={(p) => patch(selected, p)}
            onUseSuggestion={(s) => applySuggestion(selected, s, true)}
            onAskClaude={() => askClaude(selected.id)}
            onCreate={() => startCreate(selected)}
            onStatus={(s) => setStatus(selected, s)}
            onOpenThumbnails={onOpenThumbnails}
          />
        ) : (
          <Panel title="Review">
            <p className="px-4 py-10 text-center text-sm text-muted">Select an idea to review its category, title and tags, then turn it into a project.</p>
          </Panel>
        )}
      </div>

      <IdeaSettings taxonomy={taxonomy} onTaxonomy={saveTaxonomy} projectsDir={projectsDir} onChooseDir={chooseProjectsDir} ai={ai} onAi={setAi} />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-accent/10">
          <div className="rounded-lg border-2 border-dashed border-accent bg-panel px-8 py-6 text-sm font-medium">Drop screenshots to add them to the inbox</div>
        </div>
      )}

      {consentFor != null && (
        <ConfirmDialog title="Ask Claude to categorize?" confirmLabel="Send" onConfirm={() => runClaude(consentFor)} onCancel={() => setConsentFor(null)}>
          <p>
            The idea's text ({ideaText(ideas.find((i) => i.id === consentFor)!).length.toLocaleString()} characters, including text read from the screenshot) and your category list will be sent to
            Anthropic's API ({ai?.model}). The screenshot itself is not sent.
          </p>
          <p className="text-muted">One small API call per idea, billed to your key and cached. You won't be asked again this session: new ideas will get Claude's suggestion automatically.</p>
        </ConfirmDialog>
      )}

      {pending && (
        <ConfirmDialog title={`Create this project as “${pending.req.category}”?`} confirmLabel={`Create as ${pending.req.category}`} onConfirm={confirmCreate} onCancel={() => setPending(null)} busy={creating}>
          <p>
            <span className="font-medium">{pending.req.title}</span> · <Badge tone="accent">{pending.req.category}</Badge>
            {pending.req.tags.length > 0 && <span className="text-muted"> · {pending.req.tags.join(", ")}</span>}
          </p>
          <div>
            <p className="mb-1 text-xs text-muted">New folder (nothing existing is changed):</p>
            <p className="break-all font-mono text-xs">{pending.plan.folder}</p>
            <ul className="mt-1 font-mono text-xs text-muted">
              {pending.plan.entries.map((e) => (
                <li key={e} className={e.includes("/") && !e.endsWith("/") ? "pl-8" : "pl-4"}>{e.includes("/") && !e.endsWith("/") ? e.split("/").pop() : e}</li>
              ))}
            </ul>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-muted">Preview brief.md</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-sunken p-2 text-xs">{pending.plan.brief}</pre>
          </details>
        </ConfirmDialog>
      )}
    </div>
  );
}

function IdeaDetail({
  idea,
  categories,
  ocrBusy,
  aiBusy,
  ai,
  onPatch,
  onUseSuggestion,
  onAskClaude,
  onCreate,
  onStatus,
  onOpenThumbnails,
}: {
  idea: Idea;
  categories: string[];
  ocrBusy: boolean;
  aiBusy: boolean;
  ai: AiStatus | null;
  onPatch: (p: IdeaPatch) => void;
  onUseSuggestion: (s: Suggestion) => void;
  onAskClaude: () => void;
  onCreate: () => void;
  onStatus: (s: "inbox" | "archived") => void;
  onOpenThumbnails?: () => void;
}) {
  const [title, setTitle] = useState(idea.title ?? "");
  const [tags, setTags] = useState(idea.tags.join(", "));
  const [rawText, setRawText] = useState(idea.rawText ?? "");
  const [ocrText, setOcrText] = useState(idea.ocrText ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const locked = idea.status !== "inbox";
  const s = idea.suggestion;
  const differs = s && (s.title !== idea.title || s.category !== idea.category || s.tags.join() !== idea.tags.join());
  const chips = idea.category && !categories.includes(idea.category) ? [...categories, idea.category] : categories;

  useEffect(() => {
    if (!idea.hasImage) return;
    let url: string | null = null;
    api.readIdeaImage(idea.id).then((buf) => {
      url = URL.createObjectURL(new Blob([buf]));
      setImageUrl(url);
    }, () => setImageUrl(null));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [idea.id, idea.hasImage]);

  const field = "w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm disabled:bg-sunken disabled:text-muted";

  return (
    <Panel
      title="Review"
      actions={
        <>
          {idea.status === "inbox" && <Button variant="ghost" className="!py-1 text-xs" onClick={() => onStatus("archived")} title="Moves it out of the inbox. Nothing is deleted.">Archive</Button>}
          {idea.status === "archived" && <Button className="!py-1 text-xs" onClick={() => onStatus("inbox")}>Restore to inbox</Button>}
        </>
      }
    >
      <div className="space-y-4 p-4">
        {idea.status === "project" && (
          <div className="rounded-md bg-ok/10 px-3 py-2 text-sm">
            <p className="font-medium text-ok">Ready to brief</p>
            <p className="break-all font-mono text-xs">{idea.projectFolder}</p>
            <p className="mt-1 text-xs text-muted">brief.md was written when the project was created; edit it there.</p>
            {onOpenThumbnails && <Button className="mt-2 !py-1 text-xs" onClick={onOpenThumbnails}>Test thumbnails for it →</Button>}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {idea.hasImage && (
            <div className="overflow-hidden rounded-md border border-line bg-sunken">
              {imageUrl ? <img src={imageUrl} alt="Idea screenshot" className="max-h-72 w-full object-contain" /> : <p className="p-6 text-center text-xs text-muted">Loading screenshot…</p>}
            </div>
          )}
          <div className={`space-y-3 ${idea.hasImage ? "" : "md:col-span-2"}`}>
            {(idea.rawText || !idea.hasImage) && (
              <label className="block text-xs font-medium text-muted">
                Idea
                <textarea className={`${field} mt-1 h-24 resize-y`} value={rawText} disabled={locked} onChange={(e) => setRawText(e.target.value)} onBlur={() => rawText !== (idea.rawText ?? "") && onPatch({ rawText })} />
              </label>
            )}
            {idea.hasImage && (
              <label className="block text-xs font-medium text-muted">
                Text from the screenshot {ocrBusy ? <span className="text-warn">(reading…)</span> : !locked && <span className="font-normal">· fix any OCR mistakes here</span>}
                <textarea className={`${field} mt-1 h-32 resize-y`} value={ocrBusy ? "" : ocrText} disabled={locked || ocrBusy} placeholder={ocrBusy ? "Reading text on this computer…" : "No text found."} onChange={(e) => setOcrText(e.target.value)} onBlur={() => ocrText !== (idea.ocrText ?? "") && onPatch({ ocrText })} />
              </label>
            )}
          </div>
        </div>

        {!locked && (
          <div className="rounded-md border border-line px-3 py-2 text-xs">
            {s ? (
              <p>
                <span className="font-medium">{s.source === "ai" ? `Suggested by Claude (${s.model}${s.cached ? ", cached" : ""})` : "Suggested offline"}</span>
                <span className="text-muted">
                  : {s.category} · “{s.title}”{s.tags.length > 0 && ` · ${s.tags.join(", ")}`}
                  {s.reason && ` (${s.reason})`}
                </span>
              </p>
            ) : (
              <p className="text-muted">{ocrBusy ? "A suggestion appears once the text is read." : "Add some text to get a suggestion."}</p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {differs && <Button className="!py-0.5 text-xs" onClick={() => onUseSuggestion(s!)}>Use suggestion</Button>}
              {ai?.configured && s?.source !== "ai" && (
                <Button className="!py-0.5 text-xs" onClick={onAskClaude} disabled={aiBusy || ocrBusy || !ideaText(idea)}>{aiBusy ? "Asking Claude…" : "Ask Claude"}</Button>
              )}
              {aiBusy && s?.source === "ai" && <span className="text-muted">Asking Claude…</span>}
              {!ai?.configured && <span className="text-muted">Add an API key in Idea settings for Claude's suggestion.</span>}
            </div>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Category {!locked && "· confirm or change"}</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Category">
            {chips.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={idea.category === c}
                disabled={locked}
                onClick={() => onPatch({ category: c })}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${idea.category === c ? "border-accent bg-accent text-accent-ink" : "border-line hover:bg-sunken"} disabled:cursor-default`}
              >
                {c}
                {s?.category === c && idea.category !== c && <span className="ml-1 text-muted">· suggested</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-xs font-medium text-muted">
            Working title
            <input className={`${field} mt-1`} value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() !== (idea.title ?? "") && onPatch({ title: title.trim() })} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Tags (comma-separated)
            <input className={`${field} mt-1`} value={tags} disabled={locked} onChange={(e) => setTags(e.target.value)} onBlur={() => parseTags(tags).join() !== idea.tags.join() && onPatch({ tags: parseTags(tags) })} />
          </label>
        </div>

        {idea.status === "inbox" && (
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <span className="text-xs text-muted">Creates a dated folder with brief.md, script.md, assets/ and thumbnails/.</span>
            <Button variant="primary" onClick={onCreate} disabled={!idea.category || !title.trim() || ocrBusy}>
              Create project…
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

function IdeaSettings({
  taxonomy,
  onTaxonomy,
  projectsDir,
  onChooseDir,
  ai,
  onAi,
}: {
  taxonomy: Taxonomy;
  onTaxonomy: (t: Taxonomy) => Promise<void>;
  projectsDir: string | null;
  onChooseDir: () => Promise<string | null>;
  ai: AiStatus | null;
  onAi: (s: AiStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState(taxonomy.categories.join(", "));
  const [footer, setFooter] = useState(taxonomy.footer);
  const [presetId, setPresetId] = useState(taxonomy.presetId);
  useEffect(() => {
    setCategories(taxonomy.categories.join(", "));
    setFooter(taxonomy.footer);
    setPresetId(taxonomy.presetId);
  }, [taxonomy]);
  const parsed = parseCategories(categories);
  const dirty = parsed.join() !== taxonomy.categories.join() || footer !== taxonomy.footer || presetId !== taxonomy.presetId;

  function loadPreset(id: string) {
    const p = TAXONOMY_PRESETS.find((x) => x.presetId === id);
    setPresetId(id);
    if (p) {
      setCategories(p.categories.join(", "));
      setFooter(p.footer);
    }
  }

  return (
    <Panel
      title={<button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2">{open ? "▾" : "▸"} Idea settings</button>}
      actions={<span className="max-w-md truncate text-xs text-muted">{projectsDir ? `Projects: ${projectsDir}` : "No Projects folder chosen yet"}</span>}
    >
      {open && (
        <div className="grid gap-6 px-4 py-4 md:grid-cols-2">
          <div className="space-y-3">
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Projects folder</h3>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{projectsDir ?? "Not set"}</span>
                <Button onClick={onChooseDir}>{projectsDir ? "Change…" : "Choose…"}</Button>
              </div>
              <p className="mt-1 text-xs text-muted">Each project becomes Projects/&lt;date&gt;_&lt;title&gt;/ in here.</p>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Categories</h3>
              <select className="mb-2 rounded-md border border-line bg-panel px-2 py-1 text-sm" value={presetId} onChange={(e) => loadPreset(e.target.value)} aria-label="Category preset">
                {TAXONOMY_PRESETS.map((p) => <option key={p.presetId} value={p.presetId}>{p.label}</option>)}
                {!TAXONOMY_PRESETS.some((p) => p.presetId === presetId) && <option value={presetId}>Custom</option>}
              </select>
              <textarea className="h-16 w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm" value={categories} onChange={(e) => { setCategories(e.target.value); setPresetId("custom"); }} aria-label="Categories" />
              <label className="mt-2 block text-xs font-medium text-muted">
                Brief footer (added to every brief.md)
                <input className="mt-1 w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm" value={footer} onChange={(e) => setFooter(e.target.value)} />
              </label>
              <Button variant="primary" className="mt-2" disabled={!dirty || parsed.length === 0} onClick={() => onTaxonomy({ presetId, categories: parsed, footer })}>Save categories</Button>
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Claude suggestions</h3>
            <ApiKeyField ai={ai} onAi={onAi} offlineNote="Without a key, ideas still get an offline keyword suggestion." />
          </div>
        </div>
      )}
    </Panel>
  );
}
