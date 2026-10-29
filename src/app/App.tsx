import { useCallback, useEffect, useState } from "react";
import { api, inDesktopApp } from "../db/api";
import Dashboard from "../dashboard/Dashboard";
import LibraryPage from "../library/LibraryPage";
import ThumbnailsPage from "../thumbnails/ThumbnailsPage";
import IdeasPage from "../ideas/IdeasPage";
import SettingsPage from "../settings/SettingsPage";
import CommandPalette from "./CommandPalette";
import Onboarding from "./Onboarding";
import { SETTINGS } from "./settings";
import { MOD, SHORTCUTS, actionFor, isTyping } from "./shortcuts";
import { Button } from "./ui";

export type Route = "home" | "library" | "thumbnails" | "ideas" | "settings";

/** Where to land inside a page, e.g. from a search result. A new object re-applies it. */
export interface Focus {
  fileId?: number;
  filePath?: string;
  sectionId?: number;
  projectId?: number;
  ideaId?: number;
  /** Idea organizer: put the cursor in the capture box. */
  capture?: boolean;
}

export type Navigate = (route: Route, focus?: Focus) => void;

const NAV: Array<{ id: Route; label: string; key?: string }> = [
  { id: "home", label: "Home", key: "1" },
  { id: "library", label: "Media library", key: "2" },
  { id: "thumbnails", label: "Thumbnail tester", key: "3" },
  { id: "ideas", label: "Idea organizer", key: "4" },
];

export default function App() {
  const [view, setView] = useState<{ route: Route; focus: Focus | null; n: number }>({ route: "home", focus: null, n: 0 });
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [onboarding, setOnboarding] = useState(false);

  // `n` remounts the page, so navigating to the page you're on still applies the focus and
  // reloads settings changed elsewhere.
  const navigate: Navigate = useCallback((route, focus) => setView((v) => ({ route, focus: focus ?? null, n: v.n + 1 })), []);
  const { route, focus } = view;

  useEffect(() => {
    api.getSetting(SETTINGS.onboardingDone).then((done) => setOnboarding(!done), () => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (onboarding) return;
      const action = actionFor({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, typing: isTyping(e.target) });
      if (!action) {
        if (e.key === "Escape") setHelp(false);
        return;
      }
      e.preventDefault();
      if (action.kind === "palette") setPalette((p) => !p);
      else if (action.kind === "help") setHelp((h) => !h);
      else if (action.kind === "newIdea") navigate("ideas", { capture: true });
      else navigate(action.route);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, onboarding]);

  const navButton = (id: Route, label: string, hint?: string) => (
    <button
      onClick={() => navigate(id)}
      className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
        route === id ? "bg-sunken font-medium text-ink" : "text-muted hover:bg-sunken hover:text-ink"
      }`}
    >
      {label}
      {hint && <span className="text-[10px] tracking-wide text-muted opacity-0 transition group-hover:opacity-100">{hint}</span>}
    </button>
  );

  return (
    <div className="flex h-full">
      <nav className="group flex w-56 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-4 py-4">
          <div className="text-[15px] font-semibold tracking-tight">Creator Dashboard</div>
          <div className="text-xs text-muted">Local-first · nothing leaves this machine</div>
        </div>
        <div className="px-2 pb-2">
          <button onClick={() => setPalette(true)} className="flex w-full items-center justify-between rounded-md border border-line px-3 py-1.5 text-left text-sm text-muted hover:bg-sunken hover:text-ink">
            Search… <span className="text-[10px]">{MOD}+K</span>
          </button>
        </div>
        <ul className="flex-1 space-y-0.5 px-2">
          {NAV.map((item) => <li key={item.id}>{navButton(item.id, item.label, `${MOD}+${item.key}`)}</li>)}
        </ul>
        <div className="space-y-0.5 px-2 pb-2">
          {navButton("settings", "Settings", `${MOD}+,`)}
          <button onClick={() => setHelp(true)} className="w-full rounded-md px-3 py-1.5 text-left text-xs text-muted hover:bg-sunken hover:text-ink">Keyboard shortcuts (?)</button>
        </div>
        {!inDesktopApp && (
          <div className="m-3 mt-0 rounded-md bg-warn/15 p-2.5 text-xs text-warn">
            Browser preview with demo data. Run <code className="font-mono">npm run tauri dev</code> to work on real folders.
          </div>
        )}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto" key={view.n}>
        {route === "home" && <Dashboard onNavigate={navigate} />}
        {route === "library" && <LibraryPage focus={focus} />}
        {route === "thumbnails" && <ThumbnailsPage focus={focus} />}
        {route === "ideas" && <IdeasPage focus={focus} onNavigate={navigate} />}
        {route === "settings" && <SettingsPage onRunSetup={() => setOnboarding(true)} />}
      </main>

      {palette && <CommandPalette onClose={() => setPalette(false)} onNavigate={navigate} />}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
      {onboarding && (
        <Onboarding
          onDone={() => {
            setOnboarding(false);
            navigate("home");
          }}
        />
      )}
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="w-full max-w-md rounded-lg border border-line bg-panel shadow-xl">
        <div className="border-b border-line px-5 py-3 font-semibold">Keyboard shortcuts</div>
        <dl className="divide-y divide-line px-5 py-2 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex justify-between gap-4 py-1.5">
              <dt className="shrink-0 font-mono text-xs">{s.keys}</dt>
              <dd className="text-right text-muted">{s.what}</dd>
            </div>
          ))}
        </dl>
        <div className="flex justify-end border-t border-line px-5 py-3">
          <Button onClick={onClose} autoFocus>Close</Button>
        </div>
      </div>
    </div>
  );
}
