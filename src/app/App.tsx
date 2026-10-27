import { useState } from "react";
import { inDesktopApp } from "../db/api";
import Dashboard from "../dashboard/Dashboard";
import LibraryPage from "../library/LibraryPage";
import ThumbnailsPage from "../thumbnails/ThumbnailsPage";
import IdeasPage from "../ideas/IdeasPage";

export type Route = "home" | "library" | "thumbnails" | "ideas";

const NAV: Array<{ id: Route; label: string; hint?: string }> = [
  { id: "home", label: "Home" },
  { id: "library", label: "Media library" },
  { id: "thumbnails", label: "Thumbnail tester" },
  { id: "ideas", label: "Idea organizer" },
];

export default function App() {
  const [route, setRoute] = useState<Route>("home");

  return (
    <div className="flex h-full">
      <nav className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-4 py-4">
          <div className="text-[15px] font-semibold tracking-tight">Creator Dashboard</div>
          <div className="text-xs text-muted">Local-first · nothing leaves this machine</div>
        </div>
        <ul className="flex-1 space-y-0.5 px-2">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => setRoute(item.id)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                  route === item.id ? "bg-sunken font-medium text-ink" : "text-muted hover:bg-sunken hover:text-ink"
                }`}
              >
                {item.label}
                {item.hint && <span className="text-[10px] uppercase tracking-wide text-muted">{item.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
        {!inDesktopApp && (
          <div className="m-3 rounded-md bg-warn/15 p-2.5 text-xs text-warn">
            Browser preview with demo data. Run <code className="font-mono">npm run tauri dev</code> to work on real folders.
          </div>
        )}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto">
        {route === "home" && <Dashboard onNavigate={setRoute} />}
        {route === "library" && <LibraryPage />}
        {route === "thumbnails" && <ThumbnailsPage />}
        {route === "ideas" && <IdeasPage onOpenThumbnails={() => setRoute("thumbnails")} />}
      </main>
    </div>
  );
}
