// Copies Tesseract.js worker, WASM core and English language data into public/tesseract so
// OCR runs fully offline (no CDN fetches). Runs automatically before `dev` and `build`.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}public/tesseract`;
mkdirSync(out, { recursive: true });

cpSync(`${root}node_modules/tesseract.js/dist/worker.min.js`, `${out}/worker.min.js`);
const core = `${root}node_modules/tesseract.js-core`;
// The app runs the LSTM engine only, and each *.wasm.js build embeds its WASM.
for (const f of readdirSync(core).filter((f) => /^tesseract-core.*-lstm\.wasm\.js$/.test(f))) cpSync(`${core}/${f}`, `${out}/${f}`);
cpSync(`${root}node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`, `${out}/eng.traineddata.gz`);

if (!existsSync(`${out}/tesseract-core-simd-lstm.wasm.js`)) throw new Error("tesseract.js-core files missing");
console.log("OCR assets copied to public/tesseract");
