// Generates the idea-organizer fixture: a dark-mode social post screenshot with UI noise
// (status bar, handle, like count) around the idea text. Used by the capture → OCR →
// categorize → scaffold happy-path test.
// Run: node scripts/make-idea-fixtures.mjs   (output is committed; rerun only to change it)
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("../src/ideas/fixtures/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const fonts = ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"];
const font = fonts.find(existsSync);
if (!font) throw new Error("No sans font found; add a path to `fonts`.");
GlobalFonts.registerFromPath(font, "Fixture");

const c = createCanvas(900, 1000);
const ctx = c.getContext("2d");
ctx.fillStyle = "#15181e";
ctx.fillRect(0, 0, 900, 1000);
ctx.textBaseline = "alphabetic";

ctx.fillStyle = "#9aa3b2";
ctx.font = "30px Fixture";
ctx.fillText("9:41", 40, 52);
ctx.fillText("100%", 780, 52);

ctx.fillStyle = "#3b4252";
ctx.beginPath(); ctx.arc(80, 170, 40, 0, Math.PI * 2); ctx.fill();
ctx.fillStyle = "#e6e9ef";
ctx.font = "34px Fixture";
ctx.fillText("@coach.mira · 2h", 140, 182);

ctx.fillStyle = "#f2f4f8";
ctx.font = "44px Fixture";
const body = [
  "3 squat mistakes that are killing",
  "your leg day (and how to fix each",
  "one).",
  "",
  "Film it as a quick talking head",
  "with the squat rack behind me.",
];
body.forEach((line, i) => ctx.fillText(line, 50, 310 + i * 66));

ctx.fillStyle = "#9aa3b2";
ctx.font = "30px Fixture";
ctx.fillText("2.4K likes     318 replies", 50, 860);

writeFileSync(new URL("idea-screenshot.png", OUT), c.toBuffer("image/png"));
console.log("wrote idea-screenshot.png");
