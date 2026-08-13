// sync-shared.mjs — copy the canonical shared/*.js modules into each backend so
// they deploy self-contained.
//
// Why: the services deploy in isolated contexts — the broker installs npm deps
// only in ghl-broker/, and cardgen builds from a Docker context that does NOT
// include the sibling shared/ dir. So we vendor a copy into each service where
// its own node_modules resolve.
//
// shared/ (repo root) stays the SOURCE OF TRUTH — the frontend imports it via
// the @shared Vite alias. Edit there, then run `node scripts/sync-shared.mjs`.
//
// Each target only receives the files it actually imports.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, "shared");

const targets = [
  { dir: path.join(root, "cardgen", "shared"), files: ["template-schema.js", "bindings.js"] },
  { dir: path.join(root, "ghl-broker", "shared"), files: ["offer-calc.js", "rehab-catalog.js", "us-address.js", "contract-template.js", "comp-match.js"] },
];

const banner = "// AUTO-GENERATED COPY of /shared — do NOT edit here.\n// Edit /shared/<file> then run: node scripts/sync-shared.mjs\n\n";

for (const { dir, files } of targets) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f), banner + fs.readFileSync(path.join(srcDir, f), "utf8"));
  }
  console.log(`synced ${files.length} file(s) → ${path.relative(root, dir)}`);
}
