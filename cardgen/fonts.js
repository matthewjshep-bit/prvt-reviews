// fonts.js — bundled font registration + text measurement for the render engine.
//
// Two jobs:
//   1. Make librsvg (used by sharp/libvips for SVG text) resolve our 3 bundled
//      families. We do this by generating a fontconfig config that adds the
//      fonts/ dir and pointing FONTCONFIG_FILE at it. THIS MODULE MUST BE
//      IMPORTED BEFORE sharp so the env var is set before libvips initialises
//      its font subsystem.
//   2. Measure text width with opentype.js (reads the same TTFs) so the render
//      pipeline can auto-fit / wrap text (§ text layer autoFit).
//
// Bundled families (regular + bold). Inter and Source Serif ship as variable
// TTFs (single file, weight applied via the SVG font-weight attribute); Archivo
// Black is a single heavy weight. Family names below are the fonts' INTERNAL
// names so fontconfig matches them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(DIR, "fonts");

// UI/schema family id -> { file, cssName, variable }
// cssName is what we emit in SVG font-family and must equal the TTF's family.
const FAMILIES = {
  Inter: { file: "Inter.ttf", cssName: "Inter", variable: true },
  "Source Serif": { file: "SourceSerif4.ttf", cssName: "Source Serif 4", variable: true },
  "Archivo Black": { file: "ArchivoBlack-Regular.ttf", cssName: "Archivo Black", variable: false },
};

const CSS_FALLBACK =
  "'DejaVu Sans','Liberation Sans','Arial','Helvetica',sans-serif";

/* ---------- fontconfig registration (side effect on import) ---------- */

// Registers our fonts/ dir with fontconfig so librsvg (Linux/production) resolves
// our families. We write a self-contained config to a dedicated dir and point
// both FONTCONFIG_PATH (dir) and FONTCONFIG_FILE (file) at it — different
// libvips builds honour one or the other. Must run before libvips initialises.
//
// NOTE: on macOS, sharp's prebuilt renders SVG text via CoreText, which ignores
// fontconfig; local previews fall back to a system sans/serif. This is dev-only
// — production (node:20-slim + librsvg) registers the real fonts here and via
// the Dockerfile's fc-cache, and opentype measurement always uses the real TTFs.
function registerFontconfig() {
  try {
    const confDir = path.join(os.tmpdir(), "cardgen-fontconfig");
    const cacheDir = path.join(confDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const confPath = path.join(confDir, "fonts.conf");
    const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <cachedir>${cacheDir}</cachedir>
  <config></config>
</fontconfig>`;
    fs.writeFileSync(confPath, conf);
    if (!process.env.FONTCONFIG_FILE) process.env.FONTCONFIG_FILE = confPath;
    if (!process.env.FONTCONFIG_PATH) process.env.FONTCONFIG_PATH = confDir;
  } catch (err) {
    console.warn("fonts: fontconfig registration failed:", err.message);
  }
}
registerFontconfig();

/* ---------- opentype measurement ---------- */

const _loaded = new Map(); // family -> opentype.Font | null

function loadFont(family) {
  if (_loaded.has(family)) return _loaded.get(family);
  const meta = FAMILIES[family] || FAMILIES.Inter;
  let font = null;
  try {
    font = opentype.loadSync(path.join(FONT_DIR, meta.file));
  } catch (err) {
    console.warn(`fonts: could not load ${meta.file}:`, err.message);
  }
  _loaded.set(family, font);
  return font;
}

// The font-family value to emit in SVG (with fallbacks appended).
export function cssFamily(family) {
  const meta = FAMILIES[family] || FAMILIES.Inter;
  return `'${meta.cssName}',${CSS_FALLBACK}`;
}

// Measure the pixel width of a single line at a given font size.
// Variable fonts are loaded at their default (regular) instance, so bold text
// is a touch wider than measured — we pad by 6% for bold to stay overflow-safe.
export function measureLine(text, { family = "Inter", weight = "regular", fontSize = 48 } = {}) {
  const font = loadFont(family);
  if (!font) return String(text).length * fontSize * 0.55; // rough fallback metric
  let w;
  try {
    w = font.getAdvanceWidth(String(text), fontSize, { kerning: true });
  } catch {
    w = String(text).length * fontSize * 0.55;
  }
  return weight === "bold" && (FAMILIES[family]?.variable ?? true) ? w * 1.06 : w;
}

// Word-wrap `text` to fit `maxWidth`, up to `maxLines`.
// Returns { lines: string[], truncated: boolean }. `truncated` is true when
// content had to be dropped (and the last line ellipsized) to honour maxLines —
// autofit uses this to decide it must shrink further.
export function wrapText(text, { family, weight, fontSize, maxWidth, maxLines = 3 }) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const width = (s) => measureLine(s, { family, weight, fontSize });
  const lines = [];
  let line = "";
  let truncated = false;

  const pushLine = () => {
    if (lines.length < maxLines) lines.push(line);
    else truncated = true;
    line = "";
  };

  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    const trial = line ? line + " " + word : word;
    if (width(trial) <= maxWidth) {
      line = trial;
      continue;
    }
    // A lone word wider than the box: hard-break it by characters.
    if (!line && width(word) > maxWidth) {
      let chunk = "";
      for (const ch of word) {
        if (width(chunk + ch) > maxWidth && chunk) {
          line = chunk;
          pushLine();
          chunk = ch;
          if (lines.length >= maxLines) break;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
      continue;
    }
    // Normal wrap: flush current line, start a new one with this word.
    pushLine();
    if (lines.length >= maxLines) {
      truncated = true;
      line = word; // will be dropped below
      break;
    }
    line = word;
  }
  if (line) {
    if (lines.length < maxLines) lines.push(line);
    else truncated = true;
  }

  if (truncated && lines.length) {
    let last = lines[lines.length - 1];
    while (last && width(last + "…") > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last + "…";
  }
  return { lines: lines.slice(0, maxLines), truncated };
}

// Binary-search the largest font size in [minSize, maxSize] at which `text`
// wraps within maxWidth×maxHeight WITHOUT truncation. If nothing fits even at
// minSize, returns the min-size layout (ellipsized). Returns { fontSize, lines }.
export function fitText(text, { family, weight, maxSize, minSize, maxWidth, maxHeight, lineHeight = 1.2, maxLines = 3 }) {
  const loMin = Math.max(4, minSize);
  let lo = loMin;
  let hi = Math.max(lo, maxSize);
  const layoutAt = (fs) => {
    const { lines, truncated } = wrapText(text, { family, weight, fontSize: fs, maxWidth, maxLines });
    const blockH = lines.length * fs * lineHeight;
    const fits = !truncated && blockH <= maxHeight;
    return { fontSize: fs, lines, fits };
  };
  let best = layoutAt(loMin); // fallback: smallest allowed size
  for (let i = 0; i < 20 && hi - lo > 0.4; i++) {
    const mid = (lo + hi) / 2;
    const r = layoutAt(mid);
    if (r.fits) {
      best = r;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { fontSize: best.fontSize, lines: best.lines };
}

export { FAMILIES, FONT_DIR };
