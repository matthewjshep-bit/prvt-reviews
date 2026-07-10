// mapbox-pin — geocode an address and render a Mapbox Static satellite/streets
// image with a marker (kind: both). Exposes data.<id>.lat/.lng/.formatted_address.
// Server-key auth: MAPBOX_TOKEN lives in cardgen env, never the iframe.

import { z } from "zod";
import { safeFetch } from "../net.js";

const MAPBOX = "https://api.mapbox.com";
const STATIC_MAX = 1280;

const optionsSchema = z
  .object({
    mapStyle: z.enum(["satellite-streets-v12", "streets-v12", "satellite-v9", "outdoors-v12"]).default("satellite-streets-v12"),
    zoom: z.number().min(1).max(20).default(16),
    marker: z.boolean().default(true),
  })
  .strip();

export function mapboxToken() {
  return process.env.MAPBOX_TOKEN || "";
}

// Geocode → { lat, lng, formatted } (throws on miss).
export async function geocode(address) {
  const token = mapboxToken();
  if (!token) throw Object.assign(new Error("mapbox_token_missing"), { code: "no_token" });
  if (!address || !address.trim()) throw Object.assign(new Error("empty_address"), { code: "empty_address" });
  const url = `${MAPBOX}/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?limit=1&access_token=${token}`;
  const { buffer } = await safeFetch(url, { maxBytes: 1_000_000, contentTypePrefix: "application/" });
  const json = JSON.parse(buffer.toString("utf8"));
  const f = json.features?.[0];
  if (!f) throw Object.assign(new Error("geocode_no_result"), { code: "geocode_miss" });
  return { lng: f.center[0], lat: f.center[1], formatted: f.place_name || address };
}

// Request dims capped to the static-API limit; @2x then compositor downscales.
function reqDims(targetPx) {
  const w = Math.min(STATIC_MAX, Math.max(200, Math.round((targetPx?.width || 600))));
  const h = Math.min(STATIC_MAX, Math.max(200, Math.round((targetPx?.height || 600))));
  return { w, h };
}

// Fetch a static pin image buffer for a geocoded point.
export async function staticPin({ lat, lng }, options, targetPx) {
  const token = mapboxToken();
  const { w, h } = reqDims(targetPx);
  const overlay = options.marker ? `pin-l+e11d48(${lng},${lat})/` : "";
  const url = `${MAPBOX}/styles/v1/mapbox/${options.mapStyle}/static/${overlay}${lng},${lat},${options.zoom},0/${Math.round(w / 2)}x${Math.round(h / 2)}@2x?access_token=${token}`;
  const { buffer } = await safeFetch(url, { contentTypePrefix: "image/", maxBytes: 8_000_000 });
  return buffer;
}

export default {
  id: "mapbox-pin",
  name: "Mapbox pin map",
  kind: "both",
  auth: "server-key",
  description: "Satellite/streets map image centred on an address with a marker.",
  inputs: [{ key: "address", label: "Address", required: true }],
  optionsSchema,
  cacheTtlSeconds: 30 * 24 * 3600, // geometry is stable

  async resolve({ inputs, options, targetPx }) {
    const geo = await geocode(inputs.address);
    const imageBuffer = await staticPin(geo, options, targetPx);
    return {
      imageBuffer,
      data: { lat: String(geo.lat), lng: String(geo.lng), formatted_address: geo.formatted },
    };
  },
};
