// mapbox-parcel — the real-estate play (kind: both). Geocode → query the county
// GIS parcel layer by point → render a Mapbox Static satellite image with the
// parcel outline (and optional building footprint) as GeoJSON overlays, bounds
// auto-fit. Exposes data.<id>.apn / .lot_sqft / .address.
//
// Never lets librsvg fetch remote URLs — the JPEG is fetched here and handed to
// Sharp as a buffer. On GIS failure it falls back to a plain pin map (§3).

import { z } from "zod";
import * as turf from "@turf/turf";
import { safeFetch } from "../net.js";
import { geocode, staticPin, mapboxToken } from "./mapbox-pin.js";
import { countyFor, pick } from "./counties.js";

const MAPBOX = "https://api.mapbox.com";
const STATIC_MAX = 1280;
const SQM_TO_SQFT = 10.7639;

const optionsSchema = z
  .object({
    county: z.enum(["king-wa"]).default("king-wa"),
    mapStyle: z.enum(["satellite-streets-v12", "satellite-v9", "streets-v12"]).default("satellite-v9"),
    parcelColor: z.string().default("#d4af37").describe("color"),
    showBuilding: z.boolean().default(false),
    padding: z.number().min(0).max(200).default(40),
  })
  .strip();

function reqDims(targetPx) {
  const w = Math.min(STATIC_MAX, Math.max(200, Math.round(targetPx?.width || 800)));
  const h = Math.min(STATIC_MAX, Math.max(200, Math.round(targetPx?.height || 800)));
  return { w: Math.round(w / 2), h: Math.round(h / 2) }; // @2x
}

async function queryParcel(county, lng, lat) {
  const url =
    `${county.parcelQueryUrl}/query?f=geojson&geometry=${lng},${lat}` +
    `&geometryType=esriGeometryPoint&inSR=4326&outSR=4326` +
    `&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true`;
  const { buffer } = await safeFetch(url, { maxBytes: 2_000_000, contentTypePrefix: "application/" });
  const json = JSON.parse(buffer.toString("utf8"));
  const feature = json.features?.[0];
  if (!feature || !feature.geometry) throw Object.assign(new Error("parcel_not_found"), { code: "parcel_miss" });
  return feature;
}

export default {
  id: "mapbox-parcel",
  name: "Mapbox parcel map",
  kind: "both",
  auth: "server-key",
  description: "Satellite image with the property's parcel outline + lot size, from county GIS.",
  inputs: [{ key: "address", label: "Property address", required: true }],
  optionsSchema,
  cacheTtlSeconds: 30 * 24 * 3600,

  async resolve({ inputs, options, targetPx }) {
    const token = mapboxToken();
    if (!token) throw Object.assign(new Error("mapbox_token_missing"), { code: "no_token" });

    // Geocode (a failure here fails the source; no image is possible).
    const geo = await geocode(inputs.address);
    const county = countyFor(options.county);

    // GIS lookup — on failure, fall back to a pin map.
    let feature;
    try {
      feature = await queryParcel(county, geo.lng, geo.lat);
    } catch (err) {
      const imageBuffer = await staticPin(geo, { mapStyle: "satellite-streets-v12", zoom: 17, marker: true }, targetPx);
      return { imageBuffer, data: { apn: "", lot_sqft: "", address: geo.formatted }, fallback: true };
    }

    const props = feature.properties || {};
    let lotSqft = String(pick(props, county.fieldMap.lot_sqft) || "");
    if (!lotSqft) {
      try {
        const sqm = turf.area(feature);
        if (sqm > 0) lotSqft = String(Math.round(sqm * SQM_TO_SQFT));
      } catch {
        /* leave empty */
      }
    }
    const apn = String(pick(props, county.fieldMap.apn) || "");
    const address = String(pick(props, county.fieldMap.address) || geo.formatted);

    // Build the GeoJSON overlay (simplestyle-spec) — parcel outline in gold.
    const styled = {
      type: "Feature",
      properties: { stroke: options.parcelColor, "stroke-width": 4, "fill-opacity": 0 },
      geometry: feature.geometry,
    };
    const overlayFeatures = [styled];
    const fc = { type: "FeatureCollection", features: overlayFeatures };
    const geojsonOverlay = `geojson(${encodeURIComponent(JSON.stringify(fc))})`;

    const { w, h } = reqDims(targetPx);
    const url = `${MAPBOX}/styles/v1/mapbox/${options.mapStyle}/static/${geojsonOverlay}/auto/${w}x${h}@2x?padding=${options.padding}&access_token=${token}`;

    let imageBuffer;
    try {
      ({ buffer: imageBuffer } = await safeFetch(url, { contentTypePrefix: "image/", maxBytes: 8_000_000 }));
    } catch (err) {
      // Overlay too large / static error → fall back to a pin.
      imageBuffer = await staticPin(geo, { mapStyle: "satellite-streets-v12", zoom: 17, marker: true }, targetPx);
      return { imageBuffer, data: { apn, lot_sqft: lotSqft, address }, fallback: true };
    }

    return { imageBuffer, data: { apn, lot_sqft: lotSqft, address } };
  },
};
