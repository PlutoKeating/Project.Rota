// Copy pinned, unmodified OCR runtime assets. No external CDN is used by the browser.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = path.join(root, "public/vendor/ocr");
await fs.mkdir(target, { recursive: true });
const tess = path.dirname(require.resolve("tesseract.js/package.json"));
const core = path.dirname(
  createRequire(path.join(tess, "package.json")).resolve(
    "tesseract.js-core/package.json",
  ),
);
await fs.copyFile(
  path.join(tess, "dist/worker.min.js"),
  path.join(target, "worker.min.js"),
);
for (const file of await fs.readdir(core))
  if (/^tesseract-core.*\.wasm(?:\.js)?$/.test(file))
    await fs.copyFile(path.join(core, file), path.join(target, file));
for (const language of ["chi_sim", "eng"]) {
  const directory = path.dirname(
    require.resolve(`@tesseract.js-data/${language}/package.json`),
  );
  await fs.copyFile(
    path.join(directory, "4.0.0_best_int", language + ".traineddata.gz"),
    path.join(target, language + ".traineddata.gz"),
  );
}
