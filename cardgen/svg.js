// svg.js — vector-layer → SVG string builders for the render pipeline.
// Every vector layer (text, name-box, shape, badge) becomes a FULL-CANVAS SVG
// positioned internally, so it composites over bitmap layers in z-order at
// top:0,left:0 (§ render pipeline step 5). All resolved user/provider data is
// XML-escaped — it is untrusted input (§4).

import { cssFamily, measureLine, wrapText, fitText } from "./fonts.js";

export function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Accept #rgb / #rrggbb / rgb() / rgba(); anything else → fallback. Defends the
// SVG string even though template colors are zod-validated upstream.
export function safeColor(raw, fallback = "#000000") {
  if (raw == null) return fallback;
  let s = String(raw).trim();
  if (!s) return fallback;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(s)) return s;
  if (s[0] !== "#") s = "#" + s;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s.toLowerCase() : fallback;
}

const svgWeight = (w) => (w === "bold" ? "bold" : "normal");

// Badge icons, drawn in a 0..24 viewbox and scaled into place. Paths are our
// own; no remote fetch.
const ICONS = {
  star: "M12 2l2.9 6.3 6.9.7-5.1 4.7 1.4 6.8L12 17.8 5.9 21.2l1.4-6.8L2.2 9.7l6.9-.7z",
  phone: "M6.6 10.8a15 15 0 006.6 6.6l2.2-2.2a1 1 0 011-.24 11 11 0 003.5.56 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11 11 0 00.56 3.5 1 1 0 01-.24 1z",
  pin: "M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7zm0 9.5A2.5 2.5 0 1012 6.5a2.5 2.5 0 000 5z",
  check: "M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z",
  dollar: "M12 1v2.2c2.2.3 3.8 1.6 3.9 3.6h-2.2c-.1-.9-.8-1.6-1.7-1.8v3.4c2.6.6 4 1.7 4 3.9 0 2-1.6 3.4-4 3.7V21h-1.6v-2.3c-2.4-.3-4.1-1.7-4.2-3.9h2.2c.1 1 .9 1.7 2 1.9v-3.6C9.9 12.5 8.5 11.4 8.5 9.3c0-1.9 1.5-3.3 3.9-3.6V1z",
};

// Optional drop shadow filter shared by text/name-box.
function shadowDefs(id, shadow) {
  if (!shadow) return { defs: "", attr: "" };
  const color = safeColor(shadow.color, "#000000");
  const blur = Math.max(0, Number(shadow.blur) || 0);
  const dx = Number(shadow.dx) || 0;
  const dy = Number(shadow.dy) || 0;
  const defs =
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur / 2}" flood-color="${color}" flood-opacity="0.9"/>` +
    `</filter>`;
  return { defs, attr: ` filter="url(#${id})"` };
}

function wrap(inner, { W, H, opacity, rotation, cx, cy, defs = "" }) {
  const g0 = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  const t = rotation ? ` transform="rotate(${rotation} ${cx} ${cy})"` : "";
  const o = opacity != null && opacity < 1 ? ` opacity="${Math.max(0, Math.min(1, opacity))}"` : "";
  return Buffer.from(`${g0}${defs ? `<defs>${defs}</defs>` : ""}<g${t}${o}>${inner}</g></svg>`);
}

// ---------- text ----------

export function textLayerSvg(layer, resolved, box, { W, H }) {
  const family = layer.fontFamily || "Inter";
  const weight = layer.fontWeight || "regular";
  const lh = layer.lineHeight || 1.2;
  const maxLines = layer.maxLines || 3;

  let fontSize, lines;
  if (layer.autoFit) {
    ({ fontSize, lines } = fitText(resolved, {
      family, weight,
      maxSize: layer.fontSize, minSize: Math.max(6, layer.fontSize * 0.4),
      maxWidth: box.bw, maxHeight: box.bh, lineHeight: lh, maxLines,
    }));
  } else {
    fontSize = layer.fontSize;
    ({ lines } = wrapText(resolved, { family, weight, fontSize, maxWidth: box.bw, maxLines: Math.max(maxLines, 6) }));
  }

  const color = safeColor(layer.color, "#ffffff");
  const align = layer.align || "left";
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const tx = align === "center" ? box.cx : align === "right" ? box.bx + box.bw : box.bx;

  const blockH = lines.length * fontSize * lh;
  // Vertically centre the block in the box; baseline ≈ 0.8·fontSize below top.
  let baseline = box.by + (box.bh - blockH) / 2 + fontSize * 0.8;

  const { defs, attr } = shadowDefs(`sh_${layer.id}`, layer.textShadow);
  const tspans = lines
    .map((ln, i) => `<text x="${Math.round(tx)}" y="${Math.round(baseline + i * fontSize * lh)}" ` +
      `text-anchor="${anchor}" font-family="${cssFamily(family)}" font-weight="${svgWeight(weight)}" ` +
      `font-size="${Math.round(fontSize)}" fill="${color}"${attr}>${xmlEscape(ln)}</text>`)
    .join("");

  return wrap(tspans, { W, H, opacity: layer.opacity, rotation: layer.rotation, cx: box.cx, cy: box.cy, defs });
}

// ---------- name-box (auto-sized pill centred on the box centre) ----------

export function nameBoxLayerSvg(layer, resolved, box, { W, H }) {
  const family = layer.fontFamily || "Inter";
  const text = resolved || "";
  const fontSize = layer.fontSize;
  const padX = layer.paddingX ?? 54;
  const padY = layer.paddingY ?? 0;

  const textW = measureLine(text, { family, weight: "bold", fontSize });
  const pillH = Math.round(fontSize * 1.4 + padY * 2);
  const pillW = Math.round(textW + padX * 2);
  const px = Math.round(box.cx - pillW / 2);
  const py = Math.round(box.cy - pillH / 2);
  const radius = layer.cornerRadius >= pillH / 2 ? Math.round(pillH / 2) : Math.round(layer.cornerRadius || 0);
  const bg = safeColor(layer.bgColor, "#ffffff");
  const fg = safeColor(layer.textColor, "#0b0b0c");

  const inner =
    `<rect x="${px}" y="${py}" width="${pillW}" height="${pillH}" rx="${radius}" ry="${radius}" fill="${bg}"/>` +
    `<text x="${Math.round(box.cx)}" y="${Math.round(box.cy)}" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="${cssFamily(family)}" font-weight="bold" font-size="${Math.round(fontSize)}" fill="${fg}">${xmlEscape(text)}</text>`;

  return wrap(inner, { W, H, opacity: layer.opacity, rotation: layer.rotation, cx: box.cx, cy: box.cy });
}

// ---------- badge (icon + text chip) ----------

export function badgeLayerSvg(layer, resolved, box, { W, H }) {
  const family = layer.fontFamily || "Inter";
  const text = resolved || "";
  const fontSize = layer.fontSize;
  const padX = Math.round(fontSize * 0.55);
  const gap = Math.round(fontSize * 0.3);
  const iconSize = layer.icon ? Math.round(fontSize * 1.0) : 0;
  const textW = measureLine(text, { family, weight: "bold", fontSize });

  const chipH = Math.round(fontSize * 1.7);
  const chipW = Math.round(padX * 2 + iconSize + (iconSize && text ? gap : 0) + textW);
  const cx0 = Math.round(box.cx - chipW / 2);
  const cy0 = Math.round(box.cy - chipH / 2);
  const radius = (layer.cornerRadius ?? 999) >= chipH / 2 ? Math.round(chipH / 2) : Math.round(layer.cornerRadius || 0);
  const bg = safeColor(layer.bgColor, "#000000");
  const fg = safeColor(layer.textColor, "#ffffff");

  let x = cx0 + padX;
  let iconSvg = "";
  if (iconSize && ICONS[layer.icon]) {
    const scale = iconSize / 24;
    const iy = Math.round(box.cy - iconSize / 2);
    iconSvg = `<g transform="translate(${x} ${iy}) scale(${scale.toFixed(4)})"><path d="${ICONS[layer.icon]}" fill="${fg}"/></g>`;
    x += iconSize + gap;
  }
  const textSvg = text
    ? `<text x="${x}" y="${Math.round(box.cy)}" text-anchor="start" dominant-baseline="central" ` +
      `font-family="${cssFamily(family)}" font-weight="bold" font-size="${Math.round(fontSize)}" fill="${fg}">${xmlEscape(text)}</text>`
    : "";

  const inner = `<rect x="${cx0}" y="${cy0}" width="${chipW}" height="${chipH}" rx="${radius}" ry="${radius}" fill="${bg}"/>${iconSvg}${textSvg}`;
  return wrap(inner, { W, H, opacity: layer.opacity, rotation: layer.rotation, cx: box.cx, cy: box.cy });
}

// ---------- shape ----------

export function shapeLayerSvg(layer, box, { W, H }) {
  const fill = safeColor(layer.fill, "#000000");
  const stroke = layer.stroke ? safeColor(layer.stroke, "#000000") : "none";
  const sw = layer.strokeWidth || 0;
  const strokeAttr = layer.stroke && sw ? ` stroke="${stroke}" stroke-width="${sw}"` : "";
  let inner;
  if (layer.shape === "ellipse") {
    inner = `<ellipse cx="${Math.round(box.cx)}" cy="${Math.round(box.cy)}" rx="${Math.round(box.bw / 2)}" ry="${Math.round(box.bh / 2)}" fill="${fill}"${strokeAttr}/>`;
  } else if (layer.shape === "line") {
    const lw = sw || Math.max(2, Math.round(box.bh));
    inner = `<line x1="${Math.round(box.bx)}" y1="${Math.round(box.cy)}" x2="${Math.round(box.bx + box.bw)}" y2="${Math.round(box.cy)}" stroke="${layer.stroke ? stroke : fill}" stroke-width="${lw}" stroke-linecap="round"/>`;
  } else {
    const r = Math.round(layer.cornerRadius || 0);
    inner = `<rect x="${Math.round(box.bx)}" y="${Math.round(box.by)}" width="${Math.round(box.bw)}" height="${Math.round(box.bh)}" rx="${r}" ry="${r}" fill="${fill}"${strokeAttr}/>`;
  }
  return wrap(inner, { W, H, opacity: layer.opacity, rotation: layer.rotation, cx: box.cx, cy: box.cy });
}
