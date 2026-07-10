// bitmap.js — prepare a bitmap layer (uploaded image or provider image) into a
// sharp composite spec {input, top, left}, honouring fit / cornerRadius /
// opacity / rotation. Positioned by the layer's box (percent → px) computed by
// the compositor.

import sharp from "sharp";

// Rounded-rectangle alpha mask (dest-in) for cornerRadius on bitmaps.
function roundedMask(w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="${w}" height="${h}" rx="${rr}" ry="${rr}" fill="#fff"/></svg>`
  );
}

// Multiply the alpha channel by `opacity` (0–1) reliably, regardless of whether
// the source already had alpha. Returns a PNG buffer.
async function applyOpacity(buf, opacity) {
  const img = sharp(buf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    data[i + ch - 1] = Math.round(data[i + ch - 1] * opacity);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).png().toBuffer();
}

// buffer: source bitmap bytes. box: { bx,by,bw,bh,cx,cy } in px.
export async function prepareBitmap(buffer, layer, box) {
  const bw = Math.max(1, Math.round(box.bw));
  const bh = Math.max(1, Math.round(box.bh));
  const fit = layer.fit === "contain" ? "contain" : "cover";

  let pipe = sharp(buffer).resize(bw, bh, {
    fit,
    position: "centre",
    background: { r: 0, g: 0, b: 0, alpha: 0 }, // transparent letterbox for contain
  });

  // Corner radius via a rounded alpha mask.
  if (layer.cornerRadius && layer.cornerRadius > 0) {
    pipe = pipe.ensureAlpha().composite([{ input: roundedMask(bw, bh, layer.cornerRadius), blend: "dest-in" }]);
  }

  let buf = await pipe.png().toBuffer();

  if (layer.opacity != null && layer.opacity < 1) {
    buf = await applyOpacity(buf, Math.max(0, layer.opacity));
  }

  // Position by box top-left. Rotation expands the canvas, so re-centre.
  let top = Math.round(box.by);
  let left = Math.round(box.bx);
  if (layer.rotation) {
    const rotated = sharp(buf).rotate(layer.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    const out = await rotated.png().toBuffer();
    const meta = await sharp(out).metadata();
    top = Math.round(box.cy - meta.height / 2);
    left = Math.round(box.cx - meta.width / 2);
    buf = out;
  }

  return { input: buf, top, left };
}
