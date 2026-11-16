/**
 * Setting keys shared across pages. Values live in the SQLite `settings` table (JSON or plain
 * strings); pages read them when they mount, so a change in Settings applies on next visit.
 */
import { api } from "../db/api";

export const SETTINGS = {
  libraryRoot: "library.root",
  libraryPreset: "library.preset",
  customPresets: "library.customPresets",
  weights: "thumbnails.weights",
  defaultPlatform: "thumbnails.defaultPlatform",
  taxonomy: "ideas.taxonomy",
  projectsDir: "ideas.projectsDir",
  onboardingDone: "onboarding.done",
  tourDone: "tour.done",
} as const;

export async function getJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await api.getSetting(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const setJson = (key: string, value: unknown) => api.setSetting(key, JSON.stringify(value));
