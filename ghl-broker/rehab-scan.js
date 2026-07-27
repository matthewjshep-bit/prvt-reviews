// rehab-scan.js — AI scope-of-work from MLS listing photos.
// 1. Pull the listing's photos from RealEstateAPI MLS Detail (media.photosList).
// 2. Send them to Claude with the shared rehab catalog; structured outputs
//    guarantee a JSON suggestion keyed to the exact catalog item ids the
//    RehabPane UI renders.

import Anthropic from "@anthropic-ai/sdk";
import { ALL_REHAB_ITEMS, BATH_TIERS, BED_TIERS } from "./shared/rehab-catalog.js";

const MAX_PHOTOS = 16;

// Fetch listing photos (midRes ≈ 900px — plenty for condition assessment).
export async function fetchListingPhotos(address, compsApiKey) {
  const r = await fetch("https://api.realestateapi.com/v2/MLSDetail", {
    method: "POST",
    headers: { "x-api-key": compsApiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ address }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    if (r.status === 403 && /not available/i.test(detail)) {
      throw Object.assign(
        new Error("Your RealEstateAPI plan doesn't include MLS photos — upload the listing photos instead"),
        { http: 402, detail }
      );
    }
    throw Object.assign(new Error(`MLS lookup failed (${r.status})`), { http: 502, detail });
  }
  const j = await r.json();
  const media = j.data?.media || {};
  const photos = (media.photosList || [])
    .map((p) => p.midRes || p.highRes || p.lowRes)
    .filter(Boolean)
    .slice(0, MAX_PHOTOS);
  return {
    photos,
    photosCount: Number(media.photosCount) || photos.length,
    listing: {
      status: j.data?.standardStatus || j.data?.customStatus || null,
      listPrice: j.data?.listPrice || null,
      remarks: (j.data?.publicRemarks || "").slice(0, 1500) || null,
    },
  };
}

const SCAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "items", "bathrooms", "bedrooms", "custom"],
  properties: {
    summary: {
      type: "string",
      description: "2-3 sentence overall condition assessment of the property",
    },
    items: {
      type: "array",
      description: "Catalog line items that the photos show are needed",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "note"],
        properties: {
          id: { type: "string", enum: ALL_REHAB_ITEMS.map((i) => i.id) },
          note: { type: "string", description: "What in the photos justifies this item" },
        },
      },
    },
    bathrooms: {
      type: "array",
      description: "One entry per distinct bathroom visible in the photos, in order",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tier", "note"],
        properties: {
          tier: { type: "string", enum: BATH_TIERS.map((t) => t.id) },
          note: { type: "string" },
        },
      },
    },
    bedrooms: {
      type: "array",
      description: "One entry per distinct bedroom visible in the photos, in order",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tier", "note"],
        properties: {
          tier: { type: "string", enum: BED_TIERS.map((t) => t.id) },
          note: { type: "string" },
        },
      },
    },
    custom: {
      type: "array",
      description: "Visible issues not covered by the catalog",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "cost", "note"],
        properties: {
          label: { type: "string" },
          cost: { type: "integer", description: "Rough repair cost estimate in dollars" },
          note: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT =
  "You are an experienced residential rehab estimator for a house-flipping / wholesaling operation. " +
  "You review MLS listing photos and produce a conservative, evidence-based scope of work for a mid-grade " +
  "rental/flip finish level (not luxury). Rules: only include work the photos actually show is needed — do not " +
  "assume hidden problems; if a room looks recently updated, it needs no work. Prefer the cheapest catalog item " +
  "that addresses what you see (e.g. cabinet reface over new cabinets when boxes look sound). MLS photos flatter " +
  "the property, so when a finish looks dated-but-borderline, lean toward including a refresh-level item. Systems " +
  "(roof, HVAC, water heater, electrical) only when visibly aged or damaged in the photos.";

// Run the scan. settings must carry aiApiKey; subject: {beds, baths, sqft}.
export async function scanRehabFromPhotos({ photos, listing, subject, aiApiKey }) {
  const client = new Anthropic({ apiKey: aiApiKey });

  const catalogText = ALL_REHAB_ITEMS
    .map((i) => `- ${i.id}: ${i.label} (${i.mode === "sqft" ? `$${i.unit}/sqft` : i.mode === "qty" ? `$${i.unit} each` : `$${i.unit}`})`)
    .join("\n");
  const facts = [
    subject?.beds ? `${subject.beds} bedrooms` : null,
    subject?.baths ? `${subject.baths} bathrooms` : null,
    subject?.sqft ? `${subject.sqft} sqft` : null,
    listing?.listPrice ? `listed at $${Number(listing.listPrice).toLocaleString()}` : null,
  ].filter(Boolean).join(", ");

  // Photos may be public URLs (MLS CDN) or data URLs (user-uploaded).
  const toImageBlock = (p) => {
    if (p.startsWith("data:")) {
      const semi = p.indexOf(";");
      const comma = p.indexOf(",");
      return {
        type: "image",
        source: { type: "base64", media_type: p.slice(5, semi), data: p.slice(comma + 1) },
      };
    }
    return { type: "image", source: { type: "url", url: p } };
  };

  const content = [
    ...photos.slice(0, MAX_PHOTOS).map(toImageBlock),
    {
      type: "text",
      text:
        `These are the MLS listing photos for a property${facts ? ` (${facts})` : ""}.` +
        (listing?.remarks ? `\n\nListing remarks: "${listing.remarks}"` : "") +
        `\n\nAvailable catalog items (use these ids):\n${catalogText}\n\n` +
        `Bathroom tiers: ${BATH_TIERS.map((t) => `${t.id} ($${t.unit})`).join(", ")}. ` +
        `Bedroom tiers: ${BED_TIERS.map((t) => `${t.id} ($${t.unit})`).join(", ")}.\n\n` +
        `Produce the rehab scope of work.`,
    },
  ];

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: SCAN_SCHEMA } },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error("AI scan output truncated — try again"), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("AI scan was declined"), { http: 502 });
  }
  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  return JSON.parse(text);
}

// Map Anthropic SDK errors to clean HTTP responses.
export function anthropicErrorToHttp(e) {
  if (e instanceof Anthropic.AuthenticationError) {
    return Object.assign(new Error("Anthropic API key is invalid — check Settings"), { http: 400 });
  }
  if (e instanceof Anthropic.RateLimitError) {
    return Object.assign(new Error("Anthropic rate limit hit — try again shortly"), { http: 429 });
  }
  if (e instanceof Anthropic.APIError) {
    return Object.assign(new Error(`AI scan failed: ${e.message}`), { http: 502 });
  }
  return e;
}
