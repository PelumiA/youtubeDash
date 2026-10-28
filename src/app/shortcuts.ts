/** App-wide keyboard shortcuts. `actionFor` is pure so the mapping is unit-tested. */
import type { Route } from "./App";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";

export const SHORTCUTS: Array<{ keys: string; what: string }> = [
  { keys: `${MOD}+K`, what: "Search everything (files, clip sections, projects, ideas)" },
  { keys: `${MOD}+1 … ${MOD}+4`, what: "Home, Media library, Thumbnail tester, Idea organizer" },
  { keys: `${MOD}+,`, what: "Settings" },
  { keys: `${MOD}+Shift+N`, what: "Capture a new idea" },
  { keys: "?", what: "Show these shortcuts" },
  { keys: "Esc", what: "Close search, dialogs and this list" },
  { keys: `${MOD}+Enter`, what: "Idea organizer: add the typed idea" },
  { keys: `${MOD}+V`, what: "Idea organizer: capture a pasted screenshot" },
  { keys: "/", what: "Idea organizer: jump to the idea search" },
];

export type ShortcutAction = { kind: "palette" } | { kind: "help" } | { kind: "go"; route: Route } | { kind: "newIdea" };

const ROUTES: Route[] = ["home", "library", "thumbnails", "ideas"];

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Focus is in a text field, where plain keys like "?" must type. */
  typing: boolean;
}

export function actionFor(e: KeyInput): ShortcutAction | null {
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === "k") return { kind: "palette" };
  if (mod && !e.shiftKey && e.key === ",") return { kind: "go", route: "settings" };
  if (mod && !e.shiftKey && /^[1-4]$/.test(e.key)) return { kind: "go", route: ROUTES[Number(e.key) - 1] };
  if (mod && e.shiftKey && e.key.toLowerCase() === "n") return { kind: "newIdea" };
  if (!mod && !e.altKey && e.key === "?" && !e.typing) return { kind: "help" };
  return null;
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "textarea" || tag === "select" || el.isContentEditable || (tag === "input" && !["checkbox", "radio", "range", "button"].includes((el as HTMLInputElement).type));
}
