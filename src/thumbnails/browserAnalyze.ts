/** Browser-side glue: decode image bytes, run OCR in a local worker, and score. */
import { bytesToBase64 } from "../app/base64";
import type { Raster } from "./heuristics";
import { detectText, ocrWorker } from "./ocr";
import { analyzeImage } from "./pipeline";
import { PLATFORMS, type PlatformId } from "./platforms";
import { coverResize } from "./raster";
import type { Breakdown } from "./score";

export const ocrPaths = () => {
  const base = new URL("/tesseract", window.location.href).href;
  return { workerPath: `${base}/worker.min.js`, corePath: base, langPath: base };
};

/** Decodes at native size without color-space or alpha tweaks, so pixels are reproducible. */
export async function decode(bytes: ArrayBuffer): Promise<Raster> {
  const bmp = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

export function toCanvas(r: Raster): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  return canvas;
}

export async function analyzeBytes(bytes: ArrayBuffer, platform: PlatformId): Promise<{ breakdown: Breakdown; raster: Raster }> {
  const raster = await decode(bytes);
  const breakdown = await analyzeImage(raster, platform, async (ocrRaster) => detectText(await ocrWorker(ocrPaths()), toCanvas(ocrRaster), 1));
  return { breakdown, raster };
}

/** The exact image sent for AI critique: center-cropped to the platform's upload size, JPEG. */
export async function critiqueJpegBase64(raster: Raster, platform: PlatformId): Promise<string> {
  const spec = PLATFORMS[platform];
  const canvas = toCanvas(coverResize(raster, spec.width, spec.height));
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode image"))), "image/jpeg", 0.88));
  return bytesToBase64(await blob.arrayBuffer());
}
