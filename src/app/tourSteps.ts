/**
 * The guided tour: one step per area, each shown on its page with the relevant control
 * highlighted. Copy says what each module does and doesn't do, so expectations stay accurate.
 */
import type { Route } from "./App";
import { MOD } from "./shortcuts";

export interface TourStep {
  /** `data-tour` value of the element to highlight; none centres the card. */
  target?: string;
  /** Page to show behind the step. */
  route?: Route;
  title: string;
  body: string[];
}

export const TOUR: TourStep[] = [
  {
    route: "home",
    title: "Welcome to Creator Dashboard",
    body: [
      "Three tools for a solo creator: organize media, test thumbnails, and turn ideas into projects.",
      "Everything runs on this computer. Nothing is uploaded unless you ask the AI, and you confirm what's sent each session.",
    ],
  },
  {
    target: "nav-home",
    route: "home",
    title: "Home",
    body: ["Your launcher: projects in progress, recent organize runs, and how many ideas are waiting. Every project has Continue and Summary buttons."],
  },
  {
    target: "nav-library",
    route: "library",
    title: "Media library",
    body: [
      "Scan a folder to list every video, photo and audio file. Scanning only reads.",
      "Each file gets a type guessed from its shape (vertical video → reel, horizontal → talking-head, audio → b-roll). It doesn't look at what's in the clip, so fix types per row.",
      "Rename to a naming pattern and optionally sort into type folders. You always preview first, and Undo puts everything back. Duplicates are archived, never deleted.",
      "Long clips: Split… finds silences and scene cuts so you can mark and export sections.",
    ],
  },
  {
    target: "nav-thumbnails",
    route: "thumbnails",
    title: "Thumbnail tester",
    body: [
      "Add 2–4 candidates to a project and compare them for YouTube or an Instagram cover.",
      "Scores cover text readability, subject clarity, platform overlays and color. They run offline, explain themselves, and you can override any of them.",
      "Get AI critique adds an advisory hook score, only when you click it.",
    ],
  },
  {
    target: "nav-ideas",
    route: "ideas",
    title: "Idea organizer",
    body: [
      "Type an idea, or paste a screenshot with Ctrl+V anywhere on the page. Text in screenshots is read on this computer.",
      "Each idea gets a suggested category, title and tags. Confirm or change them, then Create project makes a dated folder with brief.md, script.md, assets/ and thumbnails/.",
    ],
  },
  {
    target: "search",
    title: "Search everything",
    body: [`${MOD}+K finds files, clip sections, projects and ideas, and opens the exact item.`],
  },
  {
    target: "nav-settings",
    route: "settings",
    title: "Settings",
    body: ["Media and Projects folders, naming presets, default platform, scoring weights, idea categories, and the optional AI provider (Anthropic or OpenRouter) and key."],
  },
  {
    target: "shortcuts",
    title: "That's the tour",
    body: [`Press ? any time for keyboard shortcuts (${MOD}+1–4 switch pages). You can replay this tour from Settings or the sidebar.`],
  },
];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where to put the step card: beside the highlighted element (right, else left, else below),
 * kept inside the viewport with a margin. No target → centred.
 */
export function cardPosition(target: Rect | null, card: { w: number; h: number }, viewport: { w: number; h: number }, gap = 14, margin = 12): { x: number; y: number } {
  const clampX = (x: number) => Math.max(margin, Math.min(x, viewport.w - card.w - margin));
  const clampY = (y: number) => Math.max(margin, Math.min(y, viewport.h - card.h - margin));
  if (!target) return { x: clampX((viewport.w - card.w) / 2), y: clampY((viewport.h - card.h) / 2) };
  const y = clampY(target.y + target.h / 2 - card.h / 2);
  if (target.x + target.w + gap + card.w + margin <= viewport.w) return { x: target.x + target.w + gap, y };
  if (target.x - gap - card.w >= margin) return { x: target.x - gap - card.w, y };
  return { x: clampX(target.x + target.w / 2 - card.w / 2), y: clampY(target.y + target.h + gap) };
}
