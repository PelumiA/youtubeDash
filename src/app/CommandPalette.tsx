import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SearchResults } from "../db/api";
import { basename } from "../library/paths";
import { titleFromText } from "../ideas/taxonomy";
import { formatDuration } from "./ui";
import type { Focus, Route } from "./App";
import { MOD } from "./shortcuts";

interface Item {
  key: string;
  group: string;
  title: string;
  detail?: string;
  badge?: string;
  run: () => void;
}

const GO: Array<{ route: Route; label: string }> = [
  { route: "home", label: "Home" },
  { route: "library", label: "Media library" },
  { route: "thumbnails", label: "Thumbnail tester" },
  { route: "ideas", label: "Idea organizer" },
  { route: "settings", label: "Settings" },
];

/** Ctrl+K: one box that finds files, clip sections, projects and ideas, plus navigation. */
export default function CommandPalette({ onClose, onNavigate }: { onClose: () => void; onNavigate: (r: Route, f?: Focus) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) return setResults(null);
    let stale = false;
    const t = setTimeout(() => api.searchAll(q).then((r) => !stale && setResults(r), () => !stale && setResults(null)), 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query]);

  const go = (r: Route, f?: Focus) => {
    onClose();
    onNavigate(r, f);
  };

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Item[] = [];
    const commands: Item[] = [
      ...GO.map((g) => ({ key: `go:${g.route}`, group: "Go to", title: g.label, run: () => go(g.route) })),
      { key: "new-idea", group: "Go to", title: "Capture a new idea", run: () => go("ideas", { capture: true }) },
    ];
    out.push(...(q ? commands.filter((c) => c.title.toLowerCase().includes(q)) : commands));
    if (!results) return out;
    for (const p of results.projects)
      out.push({ key: `p:${p.id}`, group: "Projects", title: p.title, detail: p.folderPath ?? undefined, badge: p.category ?? undefined, run: () => go("thumbnails", { projectId: p.id }) });
    for (const i of results.ideas)
      out.push({
        key: `i:${i.id}`,
        group: "Ideas",
        title: i.title || titleFromText([i.rawText, i.ocrText].filter(Boolean).join("\n\n")),
        detail: i.status === "project" ? "ready to brief" : i.status,
        badge: i.category ?? undefined,
        run: () => go("ideas", { ideaId: i.id }),
      });
    for (const f of results.files)
      out.push({ key: `f:${f.id}`, group: "Files", title: f.filename, detail: f.dir, badge: f.tags.length ? f.tags.join(", ") : f.kind, run: () => go("library", { fileId: f.id, filePath: f.path }) });
    for (const s of results.sections)
      out.push({
        key: `s:${s.id}`,
        group: "Clip sections",
        title: s.label,
        detail: `${basename(s.filePath)} · ${formatDuration(s.startS)}–${formatDuration(s.endS)}`,
        run: () => go("library", { fileId: s.mediaFileId, filePath: s.filePath, sectionId: s.id }),
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, results]);

  useEffect(() => setActive(0), [items.length, query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.run();
    }
  }

  const searching = query.trim() && !results;
  const nothing = query.trim() && results && items.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Search">
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
        <input
          autoFocus
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none"
          placeholder="Search files, clip sections, projects and ideas…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          aria-label="Search everything"
        />
        <ul ref={list} className="max-h-[55vh] overflow-auto py-1" role="listbox">
          {items.map((it, i) => (
            <li key={it.key}>
              {(i === 0 || items[i - 1].group !== it.group) && <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{it.group}</div>}
              <button
                data-index={i}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={it.run}
                className={`flex w-full items-baseline gap-3 px-4 py-1.5 text-left text-sm ${i === active ? "bg-sunken" : ""}`}
              >
                <span className="shrink-0 font-medium">{it.title}</span>
                {it.detail && <span className="min-w-0 flex-1 truncate text-xs text-muted">{it.detail}</span>}
                {it.badge && <span className="ml-auto shrink-0 rounded bg-sunken px-1.5 text-[10px] text-muted">{it.badge}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex justify-between border-t border-line px-4 py-1.5 text-[11px] text-muted">
          <span>{searching ? "Searching…" : nothing ? "No matches." : "↑↓ to move · Enter to open · Esc to close"}</span>
          <span>{MOD}+K</span>
        </div>
      </div>
    </div>
  );
}
