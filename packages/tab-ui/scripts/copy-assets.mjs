import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const assets = [
  ["src/browser/style/simpletab-status.css", "lib/browser/style/simpletab-status.css"],
];

for (const [srcRel, destRel] of assets) {
  const srcPath = path.join(pkgDir, srcRel);
  const destPath = path.join(pkgDir, destRel);
  mkdirSync(path.dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
}
