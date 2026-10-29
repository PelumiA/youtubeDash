import { analyzeRaster, type Raster, type TextBox } from "./heuristics";
import { PLATFORMS, type PlatformId } from "./platforms";
import { aspectWarnings, coverResize, flattenAlpha } from "./raster";
import { buildBreakdown, type Breakdown } from "./score";

/** Finds text lines in a raster at the platform's upload size; boxes in that raster's pixels. */
export type TextFinder = (ocrRaster: Raster) => Promise<TextBox[]>;

/**
 * Full heuristic pass for one image: OCR at upload size (so small text still gets found),
 * then the heuristics at analysis size. Environment-agnostic: the caller supplies decoding
 * and OCR, so the browser app and the Node tests run exactly this code.
 */
export async function analyzeImage(source: Raster, platform: PlatformId, findText: TextFinder): Promise<Breakdown> {
  const spec = PLATFORMS[platform];
  const flat = flattenAlpha(source);
  const ocrRaster = coverResize(flat, spec.width, spec.height);
  const scale = spec.analysisWidth / spec.width;
  const boxes = (await findText(ocrRaster)).map((b) => ({ ...b, x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale }));
  const analysis = coverResize(flat, spec.analysisWidth, spec.analysisHeight);
  const result = analyzeRaster(analysis, boxes, spec);
  return buildBreakdown(result, platform, analysis, { width: source.width, height: source.height }, aspectWarnings(source, spec));
}
