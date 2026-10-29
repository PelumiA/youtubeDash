// Generates the thumbnail fixture pack used by the scoring tests:
//   strong.png        big high-contrast headline, one clear subject, clear of overlays
//   cluttered.png     busy background, many small text lines, competing shapes, text under the duration badge
//   low-contrast.png  text and subject barely distinguishable from the background
// Run: node scripts/make-thumbnail-fixtures.mjs   (output is committed; rerun only to change fixtures)
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { writeFileSync, existsSync } from "node:fs";

const OUT = new URL("../src/thumbnails/fixtures/", import.meta.url);
const fonts = ["C:/Windows/Fonts/ariblk.ttf", "C:/Windows/Fonts/arialbd.ttf", "/System/Library/Fonts/Supplemental/Arial Black.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"];
const font = fonts.find(existsSync);
if (!font) throw new Error("No bold font found; add a path to `fonts`.");
GlobalFonts.registerFromPath(font, "Fixture");

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function save(name, draw) {
  const c = createCanvas(1280, 720);
  draw(c.getContext("2d"));
  writeFileSync(new URL(name, OUT), c.toBuffer("image/png"));
  console.log("wrote", name);
}

function face(ctx, x, y, r, skin, shade) {
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = shade;
  for (const dx of [-0.35, 0.35]) { ctx.beginPath(); ctx.arc(x + dx * r, y - 0.15 * r, 0.11 * r, 0, Math.PI * 2); ctx.fill(); }
  ctx.lineWidth = r * 0.08; ctx.strokeStyle = shade;
  ctx.beginPath(); ctx.arc(x, y + 0.1 * r, 0.45 * r, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
}

save("strong.png", (ctx) => {
  const g = ctx.createLinearGradient(0, 0, 1280, 720);
  g.addColorStop(0, "#0b1530"); g.addColorStop(1, "#1c2f5e");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 1280, 720);
  face(ctx, 360, 380, 240, "#ff8a2a", "#5a2300");
  ctx.font = "118px Fixture"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff"; ctx.fillText("LEG DAY", 650, 320);
  ctx.font = "140px Fixture";
  ctx.fillStyle = "#ffd23f"; ctx.fillText("FIXED", 650, 490);
});

save("cluttered.png", (ctx) => {
  const r = rng(7);
  ctx.fillStyle = "#5a5f70"; ctx.fillRect(0, 0, 1280, 720);
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${30 + Math.floor(r() * 40)}%)`;
    ctx.fillRect(Math.floor(r() * 1280), Math.floor(r() * 720), 40 + Math.floor(r() * 200), 30 + Math.floor(r() * 140));
  }
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = `hsl(${Math.floor(r() * 360)}, 85%, 55%)`;
    ctx.beginPath(); ctx.arc(120 + i * 170, 200 + Math.floor(r() * 320), 50 + Math.floor(r() * 50), 0, Math.PI * 2); ctx.fill();
  }
  face(ctx, 640, 380, 110, "#e8a070", "#4a2a10");
  ctx.font = "34px Fixture"; ctx.fillStyle = "#ffffff";
  ctx.fillText("10 SQUAT TIPS YOU NEED TO KNOW", 40, 70);
  ctx.fillText("BEFORE YOU HIT THE GYM AGAIN", 300, 560);
  ctx.fillText("PART 3", 1105, 690);
});

save("low-contrast.png", (ctx) => {
  ctx.fillStyle = "#7d7d7d"; ctx.fillRect(0, 0, 1280, 720);
  face(ctx, 360, 380, 220, "#8b8681", "#7a7672");
  ctx.font = "118px Fixture"; ctx.fillStyle = "#979797";
  ctx.fillText("LEG DAY", 650, 320);
  ctx.font = "140px Fixture";
  ctx.fillText("FIXED", 650, 490);
});
