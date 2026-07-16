// brand.js — the Brand kit re-themer. Takes any template doc and swaps its
// palette for the location's brand: dark neutral colors → brand background,
// saturated colors (the golds/ambers/blues in the starters) → brand accent,
// whites/light tones → brand text color, plus an optional font override.
// Pure + non-destructive: returns a themed deep copy; scrims (rgba overlays)
// are left alone so readability layers keep working.

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function hexToHsl(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

// "dark" | "accent" | "light" | null (null = leave untouched, e.g. rgba scrims)
export function classifyColor(color) {
  if (typeof color !== "string" || !HEX.test(color.trim())) return null;
  const { s, l } = hexToHsl(color.trim());
  // HSL saturation is unstable near white/black — decide by lightness first.
  if (l >= 0.85) return "light";
  if (l <= 0.32) return "dark";
  if (l >= 0.68 && s <= 0.35) return "light";
  if (s >= 0.25) return "accent";
  return null; // mid grays — ambiguous, leave alone
}

const FONTS = ["Inter", "Source Serif", "Archivo Black"];

// brand: { background?, accent?, text?, font? } — empty/missing values skip
// that mapping entirely.
export function applyBrand(doc, brand = {}) {
  const map = {
    dark: HEX.test(String(brand.background || "").trim()) ? brand.background.trim() : null,
    accent: HEX.test(String(brand.accent || "").trim()) ? brand.accent.trim() : null,
    light: HEX.test(String(brand.text || "").trim()) ? brand.text.trim() : null,
  };
  const font = FONTS.includes(brand.font) ? brand.font : null;
  if (!map.dark && !map.accent && !map.light && !font) return doc;

  const swap = (color) => {
    const cls = classifyColor(color);
    return cls && map[cls] ? map[cls] : color;
  };

  const out = JSON.parse(JSON.stringify(doc));
  if (out.background?.color) out.background.color = swap(out.background.color);
  for (const l of out.layers || []) {
    for (const key of ["color", "bgColor", "textColor", "fill", "stroke"]) {
      if (l[key]) l[key] = swap(l[key]);
    }
    if (l.textShadow?.color) l.textShadow.color = swap(l.textShadow.color);
    if (font && (l.type === "text" || l.type === "name-box" || l.type === "badge")) {
      l.fontFamily = font;
    }
  }
  return out;
}

export function hasBrand(brand = {}) {
  return Boolean(
    (brand.background && HEX.test(brand.background.trim())) ||
    (brand.accent && HEX.test(brand.accent.trim())) ||
    (brand.text && HEX.test(brand.text.trim())) ||
    FONTS.includes(brand.font)
  );
}

export { FONTS as BRAND_FONTS };

// Industries the gallery/starters are tagged with (starterList's `industry`).
export const INDUSTRY_LABELS = {
  "home-services": "Home services",
  roofing: "Roofing",
  "real-estate": "Real estate",
  lending: "Lending",
};
