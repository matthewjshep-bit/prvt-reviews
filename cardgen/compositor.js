// compositor.js — the render engine core. Given a validated template and a
// resolved binding context (+ optional provider images), composite every layer
// bottom-up into a single image (§ render pipeline steps 4–7).
//
// Bitmap layers go through sharp resize; vector layers become full-canvas SVGs.
// This module is pure compute: it does no DB, no provider execution, no R2. The
// caller resolves data.* / dynamic-image bitmaps and passes them in.

import sharp from "sharp";
import { parseTemplate } from "./shared/template-schema.js";
import { resolveBindings } from "./shared/bindings.js";
import { safeFetch } from "./net.js";
import { prepareBitmap } from "./bitmap.js";
import { textLayerSvg, nameBoxLayerSvg, badgeLayerSvg, shapeLayerSvg } from "./svg.js";

const JPEG_THRESHOLD = 600 * 1024; // above this, prefer JPEG for MMS
const JPEG_TARGET = 500 * 1024; // final asset target

function computeBox(layer, W, H) {
  const bx = (layer.x / 100) * W;
  const by = (layer.y / 100) * H;
  const bw = (layer.width / 100) * W;
  const bh = (layer.height / 100) * H;
  return { bx, by, bw, bh, cx: bx + bw / 2, cy: by + bh / 2 };
}

// Keep a bitmap composite within canvas bounds (guards sharp against
// out-of-range top/left from off-canvas boxes or rotation).
function clampSpec(spec, W, H) {
  const w = spec.width ?? W;
  const h = spec.height ?? H;
  let { top, left } = spec;
  let clamped = false;
  if (left < 0) { left = 0; clamped = true; }
  if (top < 0) { top = 0; clamped = true; }
  if (left + w > W) { left = Math.max(0, W - w); clamped = true; }
  if (top + h > H) { top = Math.max(0, H - h); clamped = true; }
  return { input: spec.input, top: Math.round(top), left: Math.round(left), clamped };
}

// rawTemplate: template document. context: { contact, loc, data }.
// images: { [dataSourceId]: Buffer } for dynamic-image layers.
export async function renderTemplate(rawTemplate, { context = {}, images = {}, format = "auto" } = {}) {
  const t = parseTemplate(rawTemplate);
  const W = t.canvas.width;
  const H = t.canvas.height;
  const missing = [];
  const warnings = [];

  const base = sharp({
    create: { width: W, height: H, channels: 4, background: t.background.color },
  });

  const composites = [];
  const resolve = (str) => {
    const { value, missing: m } = resolveBindings(str, context);
    if (m.length) missing.push(...m);
    return value;
  };

  for (const layer of t.layers) {
    if (layer.visible === false) continue;
    const box = computeBox(layer, W, H);

    try {
      if (layer.type === "image") {
        if (!layer.src) continue;
        const { buffer } = await safeFetch(layer.src, { contentTypePrefix: "image/", maxBytes: 10_000_000 });
        composites.push(clampSpec(await prepareBitmap(buffer, layer, box), W, H));
      } else if (layer.type === "dynamic-image") {
        const buf = images[layer.sourceId];
        if (!buf) {
          warnings.push({ layer: layer.id, error: "no_provider_image", sourceId: layer.sourceId });
          continue;
        }
        composites.push(clampSpec(await prepareBitmap(buf, layer, box), W, H));
      } else if (layer.type === "text") {
        const value = resolve(layer.content);
        if (!value.trim()) continue; // empty-binding-skips-layer
        composites.push({ input: textLayerSvg(layer, value, box, { W, H }), top: 0, left: 0 });
      } else if (layer.type === "name-box") {
        const value = resolve(layer.content);
        if (!value.trim()) continue;
        composites.push({ input: nameBoxLayerSvg(layer, value, box, { W, H }), top: 0, left: 0 });
      } else if (layer.type === "shape") {
        composites.push({ input: shapeLayerSvg(layer, box, { W, H }), top: 0, left: 0 });
      } else if (layer.type === "badge") {
        const value = resolve(layer.text);
        if (!value.trim() && !layer.icon) continue;
        composites.push({ input: badgeLayerSvg(layer, value, box, { W, H }), top: 0, left: 0 });
      }
    } catch (err) {
      warnings.push({ layer: layer.id, error: err.message });
    }
  }

  const composed = base.composite(composites);
  const out = await encode(composed, format, W);
  return { ...out, missingBindings: [...new Set(missing)], warnings, canvas: { width: W, height: H } };
}

// PNG unless it's too big for MMS, then JPEG-85, then downscale as a last resort.
async function encode(pipe, format, W) {
  if (format === "png") {
    return { buffer: await pipe.png({ compressionLevel: 9 }).toBuffer(), contentType: "image/png" };
  }
  if (format === "jpeg") {
    return { buffer: await pipe.jpeg({ quality: 85, mozjpeg: true }).toBuffer(), contentType: "image/jpeg" };
  }
  // auto
  const png = await pipe.png({ compressionLevel: 9 }).toBuffer();
  if (png.length <= JPEG_THRESHOLD) return { buffer: png, contentType: "image/png" };

  let jpeg = await sharp(png).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  if (jpeg.length > JPEG_TARGET && W > 800) {
    jpeg = await sharp(png).resize(800).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  }
  return { buffer: jpeg, contentType: "image/jpeg" };
}
