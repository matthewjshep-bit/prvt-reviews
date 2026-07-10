// service.js — cardgen render orchestration shared by the preview and generate
// endpoints. Ties together provider execution (phase 5+), compositing, output
// sizing, deterministic caching, and R2 storage.

import { renderTemplate } from "./compositor.js";
import { renderCacheKey, objectExists, putObject, publicUrlFor, sha256 } from "./storage.js";
import { runDataSources } from "./providers/run.js";

// Run a render.
//   template     — full template document
//   context      — { contact, loc, data? } resolved by the caller (broker)
//   connections  — { [connectionId]: decryptedMaterial } for provider auth
//   resolveProviders — run template.dataSources to fill data.* + dynamic images
//   store        — upload to R2 and return { url }, else return raw bytes
//   format       — 'png' | 'jpeg' | 'auto'
//   force        — bypass the render cache
// Returns (store=false): { buffer, contentType, missingBindings, warnings, providerResults }
//         (store=true):  { url, cached, cacheKey, contentType, missingBindings, warnings, providerResults, durationMs }
export async function runRender({
  template,
  context = {},
  connections = {},
  resolveProviders = false,
  store = false,
  format = "auto",
  force = false,
} = {}) {
  const started = Date.now();
  const ctx = { contact: {}, loc: {}, data: {}, ...context };
  ctx.data = { ...(ctx.data || {}) };

  // 1. Providers → fill data.* scope + dynamic-image bitmaps.
  let images = {};
  let providerResults = [];
  if (resolveProviders && Array.isArray(template.dataSources) && template.dataSources.length) {
    const out = await runDataSources({ template, context: ctx, connections });
    Object.assign(ctx.data, out.data);
    images = out.images;
    providerResults = out.providerResults;
  }

  // 2. Composite.
  const rendered = await renderTemplate(template, { context: ctx, images, format });
  const base = {
    contentType: rendered.contentType,
    missingBindings: rendered.missingBindings,
    warnings: rendered.warnings,
    providerResults,
  };

  if (!store) {
    return { ...base, buffer: rendered.buffer, durationMs: Date.now() - started };
  }

  // 3. Deterministic cache: key over template id+version + resolved data +
  //    the content hashes of any provider images (so a changed map re-renders).
  const imageHashes = {};
  for (const [k, buf] of Object.entries(images)) imageHashes[k] = sha256(buf);
  const cacheKey = renderCacheKey({
    templateId: template.id,
    templateVersion: template.version,
    resolved: ctx,
    extra: { imageHashes, format },
  });
  const ext = rendered.contentType === "image/png" ? "png" : "jpg";
  const key = `cards/${template.locationId}/${cacheKey}.${ext}`;

  if (!force && (await objectExists(key))) {
    return { ...base, url: publicUrlFor(key), cached: true, cacheKey, durationMs: Date.now() - started };
  }

  const url = await putObject(key, rendered.buffer, rendered.contentType);
  return { ...base, url, cached: false, cacheKey, r2Key: key, durationMs: Date.now() - started };
}
