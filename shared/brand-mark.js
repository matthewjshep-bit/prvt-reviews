// brand-mark.js — the Shep Flips house mark, as geometry rather than a file.
//
// The brand is data everywhere else in this codebase (wordmark, colors, links
// all live in the per-location settings blob), and a raster logo would have
// broken that: a PNG needs hosting, a hosting URL needs a bucket, and the mark
// would arrive blurry on the one surface — a 28px header — where it is always
// seen. So the mark is drawn: two strokes for the roof, a wall, and a
// four-pane window in the accent color.
//
// It is a DEFAULT, not a lock-in. A location that sets company.logoUrl gets
// its own image instead (see brandHeader in ghl-broker/dataroom.js), which is
// the escape hatch for any operator whose mark isn't a house.
//
// Returns an SVG string because its two callers live in different worlds — the
// broker's server-rendered HTML and the React console — and one string beats
// two drawings that drift apart.

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const hex = (v, fallback) => (HEX_RE.test(String(v || "")) ? String(v) : fallback);

export const BRAND_NAVY = "#16294A";
export const BRAND_GOLD = "#B8922E";

export function brandMarkSvg({ primary, accent, height = 28, title = "" } = {}) {
  const p = hex(primary, BRAND_NAVY);
  const a = hex(accent, BRAND_GOLD);
  // Proportions read off the logo itself: an asymmetric roof (apex at 54% of
  // the width, the long arm falling to the baseline on the left, the short one
  // stopping at 86% on the right), a wall hanging under that short arm, and a
  // four-pane window at 52% across. Drawn with VERTICAL thickness so the roof's
  // cut ends stay vertical the way the original does — a perpendicular stroke
  // cap reads subtly wrong next to the wordmark.
  return `<svg viewBox="0 0 46 30" height="${Number(height) || 28}" width="${
    Math.round(((Number(height) || 28) * 46) / 30)
  }" role="img" ${title ? `aria-label="${String(title).replace(/"/g, "")}"` : 'aria-hidden="true"'} focusable="false" xmlns="http://www.w3.org/2000/svg">`
    + `<path d="M1 19.4 L24.8 2 L38.8 11.6 L38.8 15.8 L24.8 6.2 L1 23.6 Z" fill="${p}"/>`
    + `<path d="M39.3 12.4 L44.6 12.4 V28 H39.3 Z" fill="${p}"/>`
    + `<g fill="${a}">`
    + `<rect x="20.4" y="17.1" width="3.4" height="3.4"/>`
    + `<rect x="24.4" y="17.1" width="3.4" height="3.4"/>`
    + `<rect x="20.4" y="21.1" width="3.4" height="3.4"/>`
    + `<rect x="24.4" y="21.1" width="3.4" height="3.4"/>`
    + `</g></svg>`;
}
