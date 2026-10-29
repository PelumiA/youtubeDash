/** Canvas sizes and UI overlay ("safe") zones per platform. Rects are fractions of the frame. */

export type PlatformId = "youtube" | "instagram";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayZone {
  id: string;
  label: string;
  rect: Rect; // fractions 0–1
  /** How much covering an important element here hurts (0–1). */
  weight: number;
}

export interface PlatformSpec {
  id: PlatformId;
  label: string;
  aspect: number; // width / height
  /** Recommended upload size. */
  width: number;
  height: number;
  /** Size the heuristics run at; small enough to be fast, large enough to be meaningful. */
  analysisWidth: number;
  analysisHeight: number;
  /** Width the image is typically seen at; text legibility is judged at this size. */
  referenceWidth: number;
  /** Preview sizes shown in the UI. */
  previews: Array<{ label: string; width: number }>;
  zones: OverlayZone[];
}

export const PLATFORMS: Record<PlatformId, PlatformSpec> = {
  youtube: {
    id: "youtube",
    label: "YouTube 16:9",
    aspect: 16 / 9,
    width: 1280,
    height: 720,
    analysisWidth: 640,
    analysisHeight: 360,
    referenceWidth: 320,
    previews: [
      { label: "Home feed (desktop)", width: 360 },
      { label: "Mobile feed", width: 320 },
      { label: "Up next sidebar", width: 168 },
    ],
    zones: [
      { id: "duration", label: "Duration badge", rect: { x: 0.84, y: 0.85, w: 0.16, h: 0.15 }, weight: 1 },
      { id: "hover", label: "Watch later / Add to queue (hover)", rect: { x: 0.87, y: 0, w: 0.13, h: 0.3 }, weight: 0.5 },
      { id: "progress", label: "Watch progress bar", rect: { x: 0, y: 0.955, w: 1, h: 0.045 }, weight: 0.3 },
    ],
  },
  instagram: {
    id: "instagram",
    label: "Instagram cover 9:16",
    aspect: 9 / 16,
    width: 1080,
    height: 1920,
    analysisWidth: 360,
    analysisHeight: 640,
    referenceWidth: 135,
    previews: [
      { label: "Reels feed", width: 270 },
      { label: "Profile grid (3:4 crop)", width: 135 },
    ],
    zones: [
      // The profile grid shows the middle 3:4 of a 9:16 cover.
      { id: "grid-top", label: "Cropped in profile grid", rect: { x: 0, y: 0, w: 1, h: 0.125 }, weight: 0.8 },
      { id: "grid-bottom", label: "Cropped in profile grid", rect: { x: 0, y: 0.875, w: 1, h: 0.125 }, weight: 0.8 },
      { id: "rail", label: "Like / comment / share rail", rect: { x: 0.84, y: 0.45, w: 0.16, h: 0.45 }, weight: 0.7 },
      { id: "caption", label: "Username & caption", rect: { x: 0, y: 0.78, w: 0.82, h: 0.22 }, weight: 0.7 },
    ],
  },
};

export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Fraction of `element` covered by `zone` (0–1). */
export function coveredFraction(element: Rect, zone: Rect): number {
  const area = element.w * element.h;
  return area > 0 ? intersectionArea(element, zone) / area : 0;
}

/** Zone rect in pixels for a canvas of the given size. */
export function zoneToPixels(rect: Rect, width: number, height: number): Rect {
  return { x: rect.x * width, y: rect.y * height, w: rect.w * width, h: rect.h * height };
}
