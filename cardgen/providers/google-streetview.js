// google-streetview — street-level photo of an address (kind: image). Uses the
// Google Street View Static API; the key stays server-side (GOOGLE_MAPS_API_KEY),
// never in the template/iframe. Checks the free metadata endpoint first so an
// address with no coverage falls back to a Mapbox satellite/pin instead of
// Google's gray "no imagery" placeholder. Exposes data.<id>.lat/.lng/.pano_date.

import { z } from "zod";
import { safeFetch } from "../net.js";
import { geocode, staticPin, mapboxToken } from "./mapbox-pin.js";

const GOOGLE = "https://maps.googleapis.com/maps/api/streetview";
const SV_MAX = 640; // Street View Static standard max per dimension

const optionsSchema = z
  .object({
    fov: z.number().min(10).max(120).default(80).describe("Field of view (zoom): lower = tighter"),
    pitch: z.number().min(-90).max(90).default(0).describe("Up/down angle"),
    heading: z.number().min(0).max(360).default(0).describe("Compass direction the camera faces (0=N)"),
    fallbackToSatellite: z.boolean().default(true).describe("If no Street View here, use a Mapbox satellite map"),
  })
  .strip();

function googleKey() {
  return process.env.GOOGLE_MAPS_API_KEY || "";
}

function dims(targetPx) {
  const w = Math.min(SV_MAX, Math.max(200, Math.round(targetPx?.width || 640)));
  const h = Math.min(SV_MAX, Math.max(200, Math.round(targetPx?.height || 640)));
  return { w, h };
}

export default {
  id: "google-streetview",
  name: "Google Street View",
  kind: "image",
  auth: "server-key",
  description: "Street-level photo of an address (falls back to a satellite map where there's no coverage).",
  inputs: [{ key: "address", label: "Address", required: true }],
  optionsSchema,
  cacheTtlSeconds: 30 * 24 * 3600,

  async resolve({ inputs, options, targetPx }) {
    const key = googleKey();
    if (!key) throw Object.assign(new Error("google_key_missing"), { code: "no_token" });
    const address = (inputs.address || "").trim();
    if (!address) throw Object.assign(new Error("empty_address"), { code: "empty_address" });

    // 1. Coverage check (free). status OK means imagery exists at/near the point.
    let meta = {};
    try {
      const metaUrl = `${GOOGLE}/metadata?location=${encodeURIComponent(address)}&key=${key}`;
      const { buffer } = await safeFetch(metaUrl, { contentTypePrefix: "application/", maxBytes: 100_000 });
      meta = JSON.parse(buffer.toString("utf8"));
    } catch {
      meta = { status: "UNKNOWN" };
    }

    if (meta.status !== "OK") {
      // 2. No Street View here → satellite fallback (if configured + Mapbox available).
      if (options.fallbackToSatellite && mapboxToken()) {
        const geo = await geocode(address);
        const imageBuffer = await staticPin(geo, { mapStyle: "satellite-streets-v12", zoom: 18, marker: true }, targetPx);
        return { imageBuffer, data: { status: "fallback_satellite", lat: String(geo.lat), lng: String(geo.lng) }, fallback: true };
      }
      throw Object.assign(new Error(`no_streetview_${meta.status || "unknown"}`), { code: "no_coverage" });
    }

    // 3. Fetch the Street View photo. return_error_code makes Google 404 rather
    //    than serve the gray placeholder if imagery vanished between calls.
    const { w, h } = dims(targetPx);
    const url =
      `${GOOGLE}?size=${w}x${h}&location=${encodeURIComponent(address)}` +
      `&fov=${options.fov}&pitch=${options.pitch}&heading=${options.heading}` +
      `&return_error_code=true&key=${key}`;
    const { buffer } = await safeFetch(url, { contentTypePrefix: "image/", maxBytes: 8_000_000 });

    return {
      imageBuffer: buffer,
      data: {
        status: "ok",
        lat: String(meta.location?.lat ?? ""),
        lng: String(meta.location?.lng ?? ""),
        pano_date: String(meta.date ?? ""),
      },
    };
  },
};
