// providers/run.js — executes a template's data sources and returns the merged
// data.* scope plus dynamic-image bitmaps. Enforces the rules every provider
// gets for free (§3): input binding-resolution, options validation, 10s
// timeout, per-provider R2 caching honouring cacheTtlSeconds, failure isolation
// (a failed source empties its data.<id>.* scope and never fails the render),
// and a per-location rate limit.

import { getProvider } from "./index.js";
import { resolveBindings } from "../../shared/bindings.js";
import { canonicalize, sha256, getJson, putJson, getObject, putObject } from "../storage.js";

const PROVIDER_TIMEOUT_MS = 10_000;
const RATE_LIMIT = Number(process.env.PROVIDER_RATE_PER_MIN || 60); // per location / minute

// naive in-memory sliding-window limiter
const hits = new Map(); // locationId -> number[] (timestamps)
function rateLimited(locationId) {
  const now = Date.now();
  const arr = (hits.get(locationId) || []).filter((t) => now - t < 60_000);
  if (arr.length >= RATE_LIMIT) {
    hits.set(locationId, arr);
    return true;
  }
  arr.push(now);
  hits.set(locationId, arr);
  return false;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${label}_timeout`), { code: "timeout" })), ms)),
  ]);
}

function targetPxFor(template, sourceId) {
  const layer = (template.layers || []).find((l) => l.type === "dynamic-image" && l.sourceId === sourceId);
  if (!layer) return undefined;
  return {
    width: Math.round((layer.width / 100) * template.canvas.width),
    height: Math.round((layer.height / 100) * template.canvas.height),
  };
}

async function runOne(ds, { template, context, connections }) {
  const started = Date.now();
  const locationId = template.locationId;
  const result = { sourceId: ds.id, provider: ds.provider, ok: false, cached: false, keys: [] };
  const provider = getProvider(ds.provider);
  if (!provider) {
    result.error = "unknown_provider";
    return { result, data: {}, image: null };
  }

  // Resolve input binding expressions against the render context.
  const inputs = {};
  for (const [k, expr] of Object.entries(ds.inputs || {})) {
    inputs[k] = resolveBindings(expr, context).value;
  }

  // Validate options against the provider schema (defaults applied).
  let options = {};
  try {
    options = provider.optionsSchema ? provider.optionsSchema.parse(ds.options || {}) : ds.options || {};
  } catch (err) {
    result.error = "invalid_options";
    return { result, data: {}, image: null };
  }

  if (provider.auth === "connection" && !connections[ds.connectionId]) {
    result.error = "connection_required";
    return { result, data: {}, image: null };
  }
  if (rateLimited(locationId)) {
    result.error = "rate_limited";
    return { result, data: {}, image: null };
  }

  const targetPx = targetPxFor(template, ds.id);
  const ttl = Math.max(0, provider.cacheTtlSeconds || 0);
  const hash = sha256(canonicalize({ inputs, options, targetPx }));
  const sidecarKey = `providers/${provider.id}/${hash}.json`;
  const imgKey = `providers/${provider.id}/${hash}.img`;

  // Cache lookup.
  if (ttl > 0) {
    const sc = await getJson(sidecarKey);
    if (sc && Date.now() - (sc.savedAt || 0) < ttl * 1000) {
      let image = null;
      if (sc.hasImage) {
        const obj = await getObject(imgKey);
        image = obj?.buffer || null;
      }
      result.ok = true;
      result.cached = true;
      result.keys = Object.keys(sc.data || {});
      result.durationMs = Date.now() - started;
      return { result, data: sc.data || {}, image };
    }
  }

  // Execute. Providers that resolve {{...}} in URL/body templates get the full
  // context plus the resolved inputs (context.inputs); URL-encoding is the
  // provider's responsibility (§4).
  try {
    const out = await withTimeout(
      provider.resolve({
        inputs, options, connection: connections[ds.connectionId], locationId, targetPx,
        context: { ...context, inputs },
      }),
      PROVIDER_TIMEOUT_MS,
      provider.id
    );
    const data = out?.data || {};
    const image = out?.imageBuffer || null;
    result.ok = true;
    result.keys = Object.keys(data);
    result.fallback = out?.fallback || false;
    result.durationMs = Date.now() - started;

    if (ttl > 0) {
      await putJson(sidecarKey, { data, savedAt: Date.now(), hasImage: Boolean(image) });
      if (image) await putObject(imgKey, image, "image/jpeg");
    }
    return { result, data, image };
  } catch (err) {
    result.error = err.code || err.message || "provider_error";
    result.durationMs = Date.now() - started;
    return { result, data: {}, image: null };
  }
}

// Run a single provider against already-resolved inputs (the editor's Test
// button). Stores an image thumbnail to R2 when the provider returns one.
export async function testProvider(id, { inputs = {}, options = {}, connection, locationId = "", targetPx, context = {} }) {
  const provider = getProvider(id);
  if (!provider) return { ok: false, error: "unknown_provider" };
  let opts = {};
  try {
    opts = provider.optionsSchema ? provider.optionsSchema.parse(options) : options;
  } catch (err) {
    return { ok: false, error: "invalid_options", detail: err.issues?.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  if (provider.auth === "connection" && !connection) return { ok: false, error: "connection_required" };
  try {
    const out = await withTimeout(
      provider.resolve({ inputs, options: opts, connection, locationId, targetPx, context: { ...context, inputs } }),
      PROVIDER_TIMEOUT_MS,
      provider.id
    );
    const data = out?.data || {};
    let imageUrl;
    if (out?.imageBuffer) {
      const sharp = (await import("sharp")).default;
      const thumb = await sharp(out.imageBuffer).resize(480, 480, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      const key = `provider-tests/${provider.id}/${sha256(canonicalize({ inputs, options: opts }))}.jpg`;
      imageUrl = await putObject(key, thumb, "image/jpeg");
    }
    return { ok: true, data, keys: Object.keys(data), imageUrl, fallback: out?.fallback || false };
  } catch (err) {
    return { ok: false, error: err.code || err.message || "provider_error" };
  }
}

export async function runDataSources({ template, context, connections = {} }) {
  const sources = template.dataSources || [];
  const settled = await Promise.all(sources.map((ds) => runOne(ds, { template, context, connections })));

  const data = {};
  const images = {};
  const providerResults = [];
  for (let i = 0; i < settled.length; i++) {
    const ds = sources[i];
    const { result, data: d, image } = settled[i];
    data[ds.id] = d || {}; // failure → empty scope (never undefined)
    if (image) images[ds.id] = image;
    providerResults.push(result);
  }
  return { data, images, providerResults };
}
