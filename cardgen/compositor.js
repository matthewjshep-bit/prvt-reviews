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

// Keep a bitmap composite within canvas bounds. Layer boxes may legitimately
// overhang the canvas (the schema allows overshoot; the editor shows it
// cropped) — so CROP the bitmap to the visible region instead of just nudging
// top/left, otherwise sharp throws "Image to composite must have same
// dimensions or smaller". Returns null when the layer is entirely off-canvas.
async function clampSpec(spec, W, H) {
  const w = spec.width ?? W;
  const h = spec.height ?? H;
  const { top, left } = spec;

  // Entirely outside the canvas → nothing to draw.
  if (left >= W || top >= H || left + w <= 0 || top + h <= 0) return null;

  const cropLeft = Math.max(0, -left);
  const cropTop = Math.max(0, -top);
  const visW = Math.min(w - cropLeft, W - Math.max(0, left));
  const visH = Math.min(h - cropTop, H - Math.max(0, top));

  let input = spec.input;
  if (cropLeft > 0 || cropTop > 0 || visW < w || visH < h) {
    input = await sharp(input)
      .extract({
        left: Math.round(cropLeft),
        top: Math.round(cropTop),
        width: Math.max(1, Math.round(visW)),
        height: Math.max(1, Math.round(visH)),
      })
      .png()
      .toBuffer();
  }
  return { input, top: Math.round(Math.max(0, top)), left: Math.round(Math.max(0, left)) };
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
        { const spec = await clampSpec(await prepareBitmap(buffer, layer, box), W, H); if (spec) composites.push(spec); }
      } else if (layer.type === "dynamic-image") {
        const buf = images[layer.sourceId];
        if (!buf) {
          warnings.push({ layer: layer.id, error: "no_provider_image", sourceId: layer.sourceId });
          continue;
        }
        { const spec = await clampSpec(await prepareBitmap(buf, layer, box), W, H); if (spec) composites.push(spec); }
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
