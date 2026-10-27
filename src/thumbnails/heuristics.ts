/**
 * Deterministic thumbnail heuristics. Pure functions over an RGBA raster (already resized to
 * the platform's analysis size) plus OCR text boxes in the same pixel space. No AI here:
 * the same pixels always produce the same scores.
 */
import { chroma, clamp01, contrastRatioFromLuminance, deltaE, ramp, redGreenOnly, relativeLuminance, rgbToLab, type Lab, type RGB } from "./color";
import { coveredFraction, type PlatformSpec, type Rect } from "./platforms";

export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array; // RGBA
}

export interface TextBox extends Rect {
  text: string;
  confidence: number;
}

export interface TextLineResult extends TextBox {
  contrast: number;
  fg: RGB;
  bg: RGB;
  /** Text height when the thumbnail is shown at the platform's reference width. */
  heightAtReference: number;
}

export interface Collision {
  element: string;
  zoneId: string;
  zoneLabel: string;
  covered: number; // 0–1 of the element
  severity: number;
}

export interface HeuristicResult {
  readability: { fraction: number; notes: string[]; lines: TextLineResult[]; words: number };
  subject: { fraction: number; notes: string[]; box: Rect | null; areaFraction: number; competitors: number; cells: number[] };
  safeZones: { fraction: number; notes: string[]; collisions: Collision[] };
  color: { fraction: number; notes: string[]; colorblindWarning: boolean };
}

const CELL = 10; // px per saliency grid cell at analysis size

function pixel(r: Raster, i: number): RGB {
  return [r.data[i * 4], r.data[i * 4 + 1], r.data[i * 4 + 2]];
}

function meanRgb(pixels: RGB[]): RGB {
  const s = [0, 0, 0];
  for (const p of pixels) {
    s[0] += p[0];
    s[1] += p[1];
    s[2] += p[2];
  }
  const n = Math.max(1, pixels.length);
  return [s[0] / n, s[1] / n, s[2] / n];
}

/** Otsu's threshold on 0–1 values: the split that best separates two classes. */
export function otsu(values: number[]): number {
  const bins = 64;
  const hist = new Array(bins).fill(0);
  for (const v of values) hist[Math.min(bins - 1, Math.floor(v * bins))]++;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }
  return (best + 1) / bins;
}

/**
 * Text vs background inside a box. Headline text is usually one flat color while backgrounds
 * vary, so the ink is the brightest or darkest pixels whose color is most uniform (falling
 * back to Otsu's minority class when both look equally flat). Measures the ink height too,
 * since OCR boxes on busy backgrounds are often taller than the glyphs.
 */
export function measureTextContrast(r: Raster, box: Rect): { contrast: number; fg: RGB; bg: RGB; inkHeight: number } {
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(r.width, Math.ceil(box.x + box.w)), y1 = Math.min(r.height, Math.ceil(box.y + box.h));
  const boxW = Math.max(0, x1 - x0), boxH = Math.max(0, y1 - y0);
  const px: RGB[] = [], lum: number[] = [], lab: Lab[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = pixel(r, y * r.width + x);
      px.push(p);
      lum.push(relativeLuminance(p));
      lab.push(rgbToLab(p));
    }
  }
  if (px.length < 16) return { contrast: 1, fg: px[0] ?? [0, 0, 0], bg: px[0] ?? [0, 0, 0], inkHeight: boxH };

  const order = lum.map((_, i) => i).sort((a, b) => lum[a] - lum[b] || a - b);
  const k = Math.max(4, Math.floor(order.length * 0.15));
  const meanLab = (ids: number[]): Lab => {
    const m: Lab = [0, 0, 0];
    for (const i of ids) for (let c = 0; c < 3; c++) m[c] += lab[i][c] / ids.length;
    return m;
  };
  const spread = (ids: number[]) => {
    const m = meanLab(ids);
    return ids.reduce((s, i) => s + deltaE(lab[i], m), 0) / ids.length;
  };
  const low = order.slice(0, k), high = order.slice(-k);
  const t = otsu(lum);
  const darkCount = lum.filter((l) => l < t).length;
  const minorityIsDark = darkCount < lum.length - darkCount;
  const [sLow, sHigh] = [spread(low), spread(high)];
  const textIsDark = Math.abs(sLow - sHigh) < 4 ? minorityIsDark : sLow < sHigh;
  const textLab = meanLab(textIsDark ? low : high);
  // Thresholds scale with how far apart the two extremes are, so faint text still separates.
  const separation = deltaE(textLab, meanLab(textIsDark ? high : low));
  const inkCut = Math.max(2, Math.min(15, separation * 0.5));
  const bgCut = Math.min(25, separation * 0.8);

  let ink = lab.map((l) => deltaE(l, textLab) < inkCut);
  if (ink.filter(Boolean).length < px.length * 0.03) ink = lum.map((l) => l < t === textIsDark);
  const fgIds = px.map((_, i) => i).filter((i) => ink[i]);
  const rest = px.map((_, i) => i).filter((i) => !ink[i]);
  const strictBg = rest.filter((i) => deltaE(lab[i], textLab) >= bgCut);
  const bgIds = strictBg.length >= rest.length * 0.1 ? strictBg : rest;
  if (!fgIds.length || !bgIds.length) return { contrast: 1, fg: px[0], bg: px[0], inkHeight: boxH };
  const fg = meanRgb(fgIds.map((i) => px[i]));
  const bg = meanRgb(bgIds.map((i) => px[i]));

  const rowInk = Array.from({ length: boxH }, (_, row) => {
    let n = 0;
    for (let col = 0; col < boxW; col++) if (ink[row * boxW + col]) n++;
    return n;
  });
  const peak = Math.max(...rowInk);
  const inked = rowInk.map((n, i) => (n >= peak * 0.15 ? i : -1)).filter((i) => i >= 0);
  const inkHeight = inked.length ? inked[inked.length - 1] - inked[0] + 1 : boxH;
  return { contrast: contrastRatioFromLuminance(relativeLuminance(fg), relativeLuminance(bg)), fg, bg, inkHeight };
}

function readability(r: Raster, boxes: TextBox[], spec: PlatformSpec): HeuristicResult["readability"] {
  const scale = spec.referenceWidth / r.width;
  const lines: TextLineResult[] = boxes.map((b) => {
    const { inkHeight, ...m } = measureTextContrast(r, b);
    return { ...b, ...m, heightAtReference: Math.min(b.h, inkHeight) * scale };
  });
  const words = lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
  if (!lines.length) {
    return { fraction: 0.5, notes: ["No text detected. That's fine for a face- or object-led thumbnail; otherwise the text may be too small or low-contrast to read."], lines, words };
  }
  const area = (l: TextLineResult) => l.w * l.h;
  const totalArea = lines.reduce((s, l) => s + area(l), 0);
  const contrast = lines.reduce((s, l) => s + Math.log(l.contrast) * area(l), 0) / totalArea;
  const meanContrast = Math.exp(contrast); // area-weighted geometric mean
  const headline = lines.reduce((a, b) => (area(b) > area(a) ? b : a));
  const smallest = lines.reduce((a, b) => (b.heightAtReference < a.heightAtReference ? b : a));

  const contrastScore = ramp(Math.log(meanContrast), Math.log(1.5), Math.log(7));
  const sizeScore = ramp(headline.heightAtReference, 6, 14);
  const wordScore = 1 - ramp(words, 4, 12);
  const notes = [
    `Text contrast ${meanContrast.toFixed(1)}:1${meanContrast >= 7 ? " (excellent)" : meanContrast >= 4.5 ? " (good)" : meanContrast >= 3 ? " (borderline)" : " (too low, text blends into the background)"}.`,
    `Headline "${headline.text}" is ${headline.heightAtReference.toFixed(0)}px tall at ${spec.referenceWidth}px wide${sizeScore < 0.6 ? ", too small to read at a glance" : ""}.`,
  ];
  if (smallest !== headline && smallest.heightAtReference < 6) notes.push(`"${smallest.text}" is only ${smallest.heightAtReference.toFixed(0)}px tall when small. Cut it or enlarge it.`);
  notes.push(words <= 4 ? `${words} word${words === 1 ? "" : "s"}: readable in a second.` : `${words} words. Aim for 4 or fewer.`);
  return { fraction: 0.6 * contrastScore + 0.25 * sizeScore + 0.15 * wordScore, notes, lines, words };
}

interface Grid {
  cols: number;
  rows: number;
  lab: Lab[];
  rgb: RGB[];
  edge: number[];
}

function buildGrid(r: Raster): Grid {
  const cols = Math.floor(r.width / CELL), rows = Math.floor(r.height / CELL);
  const lum = new Float32Array(r.width * r.height);
  for (let i = 0; i < lum.length; i++) lum[i] = relativeLuminance(pixel(r, i));
  const lab: Lab[] = [], rgb: RGB[] = [], edge: number[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const s = [0, 0, 0];
      let e = 0;
      for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
        for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
          const i = y * r.width + x;
          const p = pixel(r, i);
          s[0] += p[0];
          s[1] += p[1];
          s[2] += p[2];
          if (x > 0 && y > 0 && x < r.width - 1 && y < r.height - 1) {
            // Sobel magnitude on luminance.
            const L = (dx: number, dy: number) => lum[(y + dy) * r.width + x + dx];
            const gx = L(1, -1) + 2 * L(1, 0) + L(1, 1) - L(-1, -1) - 2 * L(-1, 0) - L(-1, 1);
            const gy = L(-1, 1) + 2 * L(0, 1) + L(1, 1) - L(-1, -1) - 2 * L(0, -1) - L(1, -1);
            e += Math.hypot(gx, gy);
          }
        }
      }
      const n = CELL * CELL;
      const c: RGB = [s[0] / n, s[1] / n, s[2] / n];
      rgb.push(c);
      lab.push(rgbToLab(c));
      edge.push(e / n);
    }
  }
  return { cols, rows, lab, rgb, edge };
}

function cellRect(g: Grid, cells: number[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cells) {
    const x = c % g.cols, y = Math.floor(c / g.cols);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0 * CELL, y: y0 * CELL, w: (x1 - x0 + 1) * CELL, h: (y1 - y0 + 1) * CELL };
}

function textCells(g: Grid, boxes: TextBox[]): Set<number> {
  const out = new Set<number>();
  for (const b of boxes) {
    for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL) && cy < g.rows; cy++) {
      for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL) && cx < g.cols; cx++) out.add(cy * g.cols + cx);
    }
  }
  return out;
}

function subject(g: Grid, boxes: TextBox[]): HeuristicResult["subject"] {
  const n = g.cols * g.rows;
  const meanLab: Lab = [0, 0, 0];
  for (const l of g.lab) {
    meanLab[0] += l[0] / n;
    meanLab[1] += l[1] / n;
    meanLab[2] += l[2] / n;
  }
  const masked = textCells(g, boxes);
  const sal = g.lab.map((l, i) => (masked.has(i) ? 0 : 0.6 * clamp01(deltaE(l, meanLab) / 50) + 0.4 * clamp01(g.edge[i] / 0.4)));
  const mean = sal.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(sal.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const threshold = Math.max(0.35, mean + 0.5 * std);

  // Connected components (8-neighbour) of salient cells.
  const label = new Int32Array(n).fill(-1);
  const comps: Array<{ cells: number[]; mass: number }> = [];
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0 || sal[i] < threshold) continue;
    const cells: number[] = [];
    let mass = 0;
    const stack = [i];
    label[i] = comps.length;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      mass += sal[c];
      const cx = c % g.cols, cy = Math.floor(c / g.cols);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
          const j = y * g.cols + x;
          if (label[j] < 0 && sal[j] >= threshold) {
            label[j] = comps.length;
            stack.push(j);
          }
        }
      }
    }
    comps.push({ cells, mass });
  }
  const significant = comps.filter((c) => c.cells.length >= Math.max(2, n * 0.005)).sort((a, b) => b.mass - a.mass || a.cells[0] - b.cells[0]);
  if (!significant.length) {
    return { fraction: 0.2, notes: ["No clear focal subject: nothing stands out from the background."], box: null, areaFraction: 0, competitors: 0, cells: [] };
  }
  const main = significant[0];
  const areaFraction = main.cells.length / n;
  const totalMass = significant.reduce((s, c) => s + c.mass, 0);
  const dominance = main.mass / totalMass;
  const competitors = significant.slice(1).filter((c) => c.mass >= main.mass * 0.35).length;

  const sizeScore = areaFraction < 0.12 ? ramp(areaFraction, 0.02, 0.12) : areaFraction <= 0.45 ? 1 : 1 - 0.5 * ramp(areaFraction, 0.45, 0.7);
  const competitorScore = [1, 0.6, 0.3][competitors] ?? 0;
  const notes = [
    `Main subject fills ${(areaFraction * 100).toFixed(0)}% of the frame${areaFraction < 0.08 ? ". Too small to register in a feed, so go closer" : areaFraction > 0.6 ? " and lacks breathing room" : ""}.`,
    competitors === 0 ? "One clear focal point." : `${competitors} other element${competitors === 1 ? "" : "s"} compete${competitors === 1 ? "s" : ""} for attention.`,
  ];
  return { fraction: 0.35 * sizeScore + 0.35 * dominance + 0.3 * competitorScore, notes, box: cellRect(g, main.cells), areaFraction, competitors, cells: main.cells };
}

function safeZones(r: Raster, spec: PlatformSpec, lines: TextLineResult[], subj: HeuristicResult["subject"], g: Grid): HeuristicResult["safeZones"] {
  const W = r.width, H = r.height;
  const frac = (b: Rect): Rect => ({ x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H });
  const headline = lines.length ? lines.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a)) : null;
  const collisions: Collision[] = [];
  for (const zone of spec.zones) {
    for (const line of lines) {
      const covered = coveredFraction(frac(line), zone.rect);
      if (covered >= 0.1) {
        const importance = line === headline ? 1 : 0.6;
        collisions.push({ element: `Text "${line.text}"`, zoneId: zone.id, zoneLabel: zone.label, covered, severity: covered * zone.weight * importance });
      }
    }
    if (subj.cells.length) {
      // Measured on the subject's own cells, not its bounding box, so a big subject isn't over-penalised.
      const inside = subj.cells.filter((c) => {
        const cx = ((c % g.cols) + 0.5) * CELL / W, cy = (Math.floor(c / g.cols) + 0.5) * CELL / H;
        return cx >= zone.rect.x && cx <= zone.rect.x + zone.rect.w && cy >= zone.rect.y && cy <= zone.rect.y + zone.rect.h;
      }).length;
      const covered = inside / subj.cells.length;
      if (covered >= 0.1) collisions.push({ element: "Main subject", zoneId: zone.id, zoneLabel: zone.label, covered, severity: covered * zone.weight });
    }
  }
  collisions.sort((a, b) => b.severity - a.severity);
  const penalty = collisions.reduce((s, c) => s + c.severity, 0);
  const notes = collisions.length
    ? collisions.map((c) => `${c.element} is ${(c.covered * 100).toFixed(0)}% under the ${c.zoneLabel.toLowerCase()}.`)
    : ["Nothing important sits under the platform's overlays."];
  return { fraction: clamp01(1 - penalty), notes, collisions };
}

function color(g: Grid, subj: HeuristicResult["subject"], lines: TextLineResult[], masked: Set<number>): HeuristicResult["color"] {
  const lum = g.rgb.map(relativeLuminance);
  const meanL = lum.reduce((a, b) => a + b, 0) / lum.length;
  const stdL = Math.sqrt(lum.reduce((a, b) => a + (b - meanL) ** 2, 0) / lum.length);
  const meanChroma = g.lab.reduce((s, l) => s + chroma(l), 0) / g.lab.length;
  const contrastScore = ramp(stdL, 0.04, 0.25);
  const satScore = ramp(meanChroma, 5, 40);

  const subjSet = new Set(subj.cells);
  const subjCells = subj.cells, bgCells = g.rgb.map((_, i) => i).filter((i) => !subjSet.has(i) && !masked.has(i));
  let sepScore = 0.3;
  let subjRgb: RGB | null = null, bgRgb: RGB | null = null;
  if (subjCells.length && bgCells.length) {
    subjRgb = meanRgb(subjCells.map((i) => g.rgb[i]));
    bgRgb = meanRgb(bgCells.map((i) => g.rgb[i]));
    sepScore = ramp(deltaE(rgbToLab(subjRgb), rgbToLab(bgRgb)), 5, 40);
  }
  const notes = [
    `Tonal contrast ${contrastScore >= 0.7 ? "strong" : contrastScore >= 0.4 ? "moderate" : "flat"}; colors ${satScore >= 0.7 ? "vivid" : satScore >= 0.4 ? "moderate" : "muted"}.`,
    subjRgb ? `Subject ${sepScore >= 0.7 ? "pops from" : sepScore >= 0.4 ? "is distinguishable from" : "blends into"} the background.` : "No subject to separate from the background.",
  ];
  const pairs: Array<[string, RGB, RGB]> = [];
  if (subjRgb && bgRgb) pairs.push(["subject and background", subjRgb, bgRgb]);
  for (const l of lines) pairs.push([`text "${l.text}"`, l.fg, l.bg]);
  const flagged = pairs.filter(([, a, b]) => redGreenOnly(a, b).flagged);
  if (flagged.length) notes.push(`Color-blind check: ${flagged.map((f) => f[0]).join(", ")} differ only by red/green hue, which looks similar to ~8% of men. Add a brightness difference.`);
  const fraction = clamp01(0.35 * contrastScore + 0.25 * satScore + 0.4 * sepScore - (flagged.length ? 0.25 : 0));
  return { fraction, notes, colorblindWarning: flagged.length > 0 };
}

/** Runs every heuristic. `raster` must be at the platform's analysis size. */
export function analyzeRaster(raster: Raster, boxes: TextBox[], spec: PlatformSpec): HeuristicResult {
  const read = readability(raster, boxes, spec);
  const g = buildGrid(raster);
  const subj = subject(g, boxes);
  return {
    readability: read,
    subject: subj,
    safeZones: safeZones(raster, spec, read.lines, subj, g),
    color: color(g, subj, read.lines, textCells(g, boxes)),
  };
}
