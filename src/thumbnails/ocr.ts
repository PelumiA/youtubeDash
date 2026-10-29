/**
 * Local OCR via Tesseract.js (WASM, runs on this machine; no network). Used to find text
 * lines and their boxes; the scoring itself is done by the heuristics.
 */
import { createWorker, PSM, type Worker } from "tesseract.js";
import type { TextBox } from "./heuristics";

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrPaths {
  workerPath?: string;
  corePath?: string;
  langPath: string;
}

let shared: Promise<Worker> | null = null;

export function ocrWorker(paths: OcrPaths): Promise<Worker> {
  shared ??= (async () => {
    const worker = await createWorker("eng", 1, {
      ...paths,
      workerBlobURL: false,
      cacheMethod: "none",
    });
    // Thumbnails have a few scattered words, not paragraphs.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    return worker;
  })();
  return shared;
}

export async function terminateOcr(): Promise<void> {
  const w = shared;
  shared = null;
  if (w) await (await w).terminate();
}

/** Flattens Tesseract's block tree to words. */
export function wordsFromBlocks(blocks: unknown): OcrWord[] {
  const out: OcrWord[] = [];
  for (const b of (blocks as any[]) ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const w of l.words ?? []) out.push(w);
  return out;
}

/**
 * Keeps confident, real words and groups them into visual lines. `scale` maps OCR pixel
 * coordinates to analysis-size coordinates.
 */
export function linesFromWords(words: OcrWord[], scale: number): TextBox[] {
  const good = words
    .map((w) => ({ ...w, text: w.text.trim() }))
    .filter((w) => /[A-Za-z0-9]/.test(w.text) && w.confidence >= (w.text.length === 1 ? 75 : 55))
    .map((w) => ({ text: w.text, confidence: w.confidence, x: w.bbox.x0 * scale, y: w.bbox.y0 * scale, w: (w.bbox.x1 - w.bbox.x0) * scale, h: (w.bbox.y1 - w.bbox.y0) * scale }))
    .filter((w) => w.h >= 4 && w.w >= 3)
    .sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);

  const lines: Array<TextBox & { n: number }> = [];
  for (const w of good) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.y + l.h, w.y + w.h) - Math.max(l.y, w.y);
      const gap = Math.max(w.x - (l.x + l.w), l.x - (w.x + w.w));
      return overlap >= 0.5 * Math.min(l.h, w.h) && gap <= 1.5 * Math.max(l.h, w.h);
    });
    if (!line) {
      lines.push({ ...w, n: 1 });
      continue;
    }
    const x1 = Math.max(line.x + line.w, w.x + w.w), y1 = Math.max(line.y + line.h, w.y + w.h);
    const leftFirst = w.x < line.x;
    line.text = leftFirst ? `${w.text} ${line.text}` : `${line.text} ${w.text}`;
    line.confidence = (line.confidence * line.n + w.confidence) / (line.n + 1);
    line.n += 1;
    line.x = Math.min(line.x, w.x);
    line.y = Math.min(line.y, w.y);
    line.w = x1 - line.x;
    line.h = y1 - line.y;
  }
  return lines.map(({ n: _n, ...l }) => ({ ...l, x: Math.round(l.x * 10) / 10, y: Math.round(l.y * 10) / 10, w: Math.round(l.w * 10) / 10, h: Math.round(l.h * 10) / 10 }));
}

const iou = (a: TextBox, b: TextBox) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const inter = w > 0 && h > 0 ? w * h : 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
};

/** Union of two passes' lines; where they overlap, the more confident reading wins. */
export function mergeLines(a: TextBox[], b: TextBox[]): TextBox[] {
  const out = [...a];
  for (const line of b) {
    const i = out.findIndex((o) => iou(o, line) > 0.3);
    if (i < 0) out.push(line);
    else if (line.confidence > out[i].confidence) out[i] = line;
  }
  return out.sort((p, q) => p.y - q.y || p.x - q.x);
}

/**
 * OCR an image (canvas or encoded bytes) and return text lines. Two passes: Tesseract's
 * global threshold reads text on flat backgrounds (including low-contrast text), adaptive
 * (Sauvola) thresholding reads text over busy photos.
 */
export async function detectText(worker: Worker, image: Parameters<Worker["recognize"]>[0], scale: number): Promise<TextBox[]> {
  const passes: TextBox[][] = [];
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  for (const method of ["0", "2"]) {
    await worker.setParameters({ thresholding_method: method } as never);
    const { data } = await worker.recognize(image, {}, { blocks: true });
    passes.push(linesFromWords(wordsFromBlocks(data.blocks), scale));
  }
  return mergeLines(passes[0], passes[1]);
}

/**
 * OCR a screenshot of mostly text (a post, a note) into plain text in reading order. The
 * shared worker is tuned for thumbnails, so page segmentation is switched for this call.
 */
export async function recognizePlainText(worker: Worker, image: Parameters<Worker["recognize"]>[0]): Promise<string> {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, thresholding_method: "0" } as never);
  try {
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  }
}
