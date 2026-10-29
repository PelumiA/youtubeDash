import type { Raster } from "./heuristics";

/**
 * Center-crops `src` to the target aspect, then area-averages it down (or nearest-samples up)
 * to `width`×`height`. Pure JS so results are identical in every webview and in tests.
 */
export function coverResize(src: Raster, width: number, height: number): Raster {
  const targetAspect = width / height;
  let cw = src.width, ch = src.height;
  if (cw / ch > targetAspect) cw = Math.round(ch * targetAspect);
  else ch = Math.round(cw / targetAspect);
  const ox = Math.floor((src.width - cw) / 2), oy = Math.floor((src.height - ch) / 2);

  const out = new Uint8ClampedArray(width * height * 4);
  const sx = cw / width, sy = ch / height;
  for (let y = 0; y < height; y++) {
    const y0 = oy + y * sy, y1 = oy + (y + 1) * sy;
    for (let x = 0; x < width; x++) {
      const x0 = ox + x * sx, x1 = ox + (x + 1) * sx;
      const acc = [0, 0, 0, 0];
      let wsum = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        const wy = Math.min(py + 1, y1) - Math.max(py, y0);
        if (wy <= 0) continue;
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const wx = Math.min(px + 1, x1) - Math.max(px, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (Math.min(py, src.height - 1) * src.width + Math.min(px, src.width - 1)) * 4;
          acc[0] += src.data[i] * w;
          acc[1] += src.data[i + 1] * w;
          acc[2] += src.data[i + 2] * w;
          acc[3] += src.data[i + 3] * w;
          wsum += w;
        }
      }
      const o = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = Math.round(acc[k] / wsum);
    }
  }
  return { width, height, data: out };
}

/** Flattens transparency onto black, the way YouTube renders transparent PNG thumbnails. */
export function flattenAlpha(r: Raster): Raster {
  const data = new Uint8ClampedArray(r.data.length);
  for (let i = 0; i < r.data.length; i += 4) {
    const a = r.data[i + 3] / 255;
    data[i] = r.data[i] * a;
    data[i + 1] = r.data[i + 1] * a;
    data[i + 2] = r.data[i + 2] * a;
    data[i + 3] = 255;
  }
  return { width: r.width, height: r.height, data };
}

export function aspectWarnings(source: { width: number; height: number }, spec: { aspect: number; width: number; label: string }): string[] {
  const out: string[] = [];
  const aspect = source.width / source.height;
  if (Math.abs(aspect - spec.aspect) / spec.aspect > 0.03) {
    out.push(`Image is ${source.width}×${source.height}; ${spec.label} expects ${spec.aspect > 1 ? "16:9" : "9:16"}. Scored on the center crop, but the platform may crop or letterbox it differently.`);
  }
  if (source.width < spec.width * 0.99 && source.height < (spec.width / spec.aspect) * 0.99) {
    out.push(`Image is smaller than the recommended ${spec.width}px wide and may look soft.`);
  }
  return out;
}
