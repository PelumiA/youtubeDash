/**
 * Screenshot → text, locally. Screenshots are often dark mode and sometimes small, both of
 * which hurt Tesseract, so the image is converted to dark-on-light grayscale and small
 * images are upscaled before recognition.
 */
import type { Raster } from "../thumbnails/heuristics";
import { recognizePlainText } from "../thumbnails/ocr";
import type { Worker } from "tesseract.js";
import { cleanOcrText } from "./taxonomy";

/** Below this width text is usually too small for Tesseract; such images are upscaled 2×. */
const MIN_OCR_WIDTH = 1000;

export function prepareForOcr(src: Raster): Raster {
  const { width: w, height: h, data } = src;
  const gray = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    // Transparent pixels read as white (what a viewer would see on a light page).
    const y = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) * a + 255 * (1 - a);
    gray[i] = y;
    sum += y;
  }
  if (sum / (w * h) < 128) for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];

  const scale = w < MIN_OCR_WIDTH ? 2 : 1;
  const W = w * scale, H = h * scale;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    // Bilinear sample at the source pixel centre.
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const v =
        gray[y0 * w + x0] * (1 - fx) * (1 - fy) + gray[y0 * w + x1] * fx * (1 - fy) + gray[y1 * w + x0] * (1 - fx) * fy + gray[y1 * w + x1] * fx * fy;
      const o = (y * W + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

/** OCR a prepared image; `encode` turns the raster into something Tesseract accepts. */
export async function readText<T>(worker: Worker, raster: Raster, encode: (r: Raster) => T): Promise<string> {
  return cleanOcrText(await recognizePlainText(worker, encode(prepareForOcr(raster)) as never));
}
