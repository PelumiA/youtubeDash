/** Color math for thumbnail scoring: WCAG contrast, CIELAB distance, color-vision simulation. */

export type RGB = [number, number, number]; // 0–255 sRGB
export type Lab = [number, number, number];

const LINEAR = new Float64Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export function toLinear(c: number): number {
  return LINEAR[Math.max(0, Math.min(255, Math.round(c)))];
}

function fromLinear(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, v * 255));
}

/** WCAG 2.x relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two luminances, 1:1 to 21:1. */
export function contrastRatioFromLuminance(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export function contrastRatio(a: RGB, b: RGB): number {
  return contrastRatioFromLuminance(relativeLuminance(a), relativeLuminance(b));
}

export function rgbToLab([r, g, b]: RGB): Lab {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE. ~2.3 is a just-noticeable difference; >40 is strongly distinct. */
export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function chroma([, a, b]: Lab): number {
  return Math.hypot(a, b);
}

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
const MATRICES = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
} as const;

export type ColorVision = keyof typeof MATRICES;

export function simulate(rgb: RGB, vision: ColorVision): RGB {
  const lin = rgb.map(toLinear);
  const m = MATRICES[vision];
  return m.map((row) => fromLinear(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])) as RGB;
}

/**
 * Flags pairs of colors that are clearly different for typical vision but collapse for
 * red/green color-blind viewers (about 1 in 12 men), i.e. hue is the only differentiator.
 */
export function redGreenOnly(a: RGB, b: RGB): { normal: number; worst: number; flagged: boolean } {
  const normal = deltaE(rgbToLab(a), rgbToLab(b));
  const worst = Math.min(
    ...(["deuteranopia", "protanopia"] as const).map((v) => deltaE(rgbToLab(simulate(a, v)), rgbToLab(simulate(b, v)))),
  );
  return { normal, worst, flagged: normal >= 20 && worst < 15 && worst < normal * 0.5 };
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Linear ramp: 0 at `lo`, 1 at `hi` (works for either direction). */
export function ramp(x: number, lo: number, hi: number): number {
  return clamp01((x - lo) / (hi - lo));
}
