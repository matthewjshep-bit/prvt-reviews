// rehab-scan.js — AI scope-of-work from MLS listing photos.
// 1. Pull the listing's photos from RealEstateAPI MLS Detail (media.photosList).
// 2. Send them to Claude with the shared rehab catalog; structured outputs
//    guarantee a JSON suggestion keyed to the exact catalog item ids the
//    RehabPane UI renders.

import Anthropic from "@anthropic-ai/sdk";
import { ALL_REHAB_ITEMS, BATH_TIERS, BED_TIERS } from "./shared/rehab-catalog.js";
import { addressQueryVariants } from "./shared/us-address.js";

const MAX_PHOTOS = 40;

// Fetch listing photos (midRes ≈ 900px — plenty for condition assessment).
// The provider's address matcher is picky and inconsistent about formats, so
// walk the variant ladder (see shared/us-address.js) until one resolves.
export async function fetchListingPhotos(address, compsApiKey) {
  const tryOnce = async (addr) => {
    const r = await fetch("https://api.realestateapi.com/v2/MLSDetail", {
      method: "POST",
      headers: { "x-api-key": compsApiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ address: addr }),
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
  };

  let empty = null;
  let lastErr = null;
  for (const variant of addressQueryVariants(address)) {
    try {
      const out = await tryOnce(variant);
      if (out.photos.length) return out;
      if (!empty) empty = out;
    } catch (e) {
      if (e.http === 402) throw e; // plan limitation — retrying won't help
      lastErr = e;
    }
  }
  if (empty) return empty;
  throw lastErr || Object.assign(new Error("MLS lookup failed"), { http: 502 });
}

// Fetch listing photos from Zillow via Apify's zillow-detail-scraper actor —
// the practical photo source for accounts without RealEstateAPI's MLS add-on.
// One synchronous actor run: address in, dataset items (facts + photos) out.
// Caveat, acknowledged when this was chosen: unofficial scraper, Zillow ToS.
const APIFY_ACTOR = "maxcopell~zillow-detail-scraper";

// Pick a jpeg rendition near 1536px from Zillow's mixedSources photo shape.
function bestPhotoUrl(photo) {
  const jpegs = photo?.mixedSources?.jpeg || [];
  if (jpegs.length) {
    const under = jpegs.filter((j) => j.width <= 1536).sort((a, b) => b.width - a.width);
    return (under[0] || jpegs.sort((a, b) => a.width - b.width)[0])?.url || null;
  }
  return photo?.url || null;
}

export async function fetchZillowPhotos(address, apifyToken) {
  const r = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}&timeout=180`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [address] }),
      signal: AbortSignal.timeout(200000),
    }
  );
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw Object.assign(new Error(`Zillow lookup failed (Apify ${r.status})`), {
      http: r.status === 401 || r.status === 403 ? 400 : 502,
      detail,
    });
  }
  const items = await r.json();
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) {
    throw Object.assign(new Error("Zillow couldn't match that address"), { http: 404 });
  }
  const rawPhotos = item.photos?.length ? item.photos : item.responsivePhotos || [];
  const photos = rawPhotos.map(bestPhotoUrl).filter(Boolean).slice(0, MAX_PHOTOS);
  return {
    photos,
    photosCount: rawPhotos.length,
    listing: {
      status: item.homeStatus || null,
      listPrice: item.price || null,
      remarks: (item.description || "").slice(0, 1500) || null,
    },
    facts: {
      beds: Number(item.bedrooms) || null,
      baths: Number(item.bathrooms) || null,
      sqft: Number(item.livingArea) || null,
      yearBuilt: Number(item.yearBuilt) || Number(item.resoFacts?.yearBuilt) || null,
    },
  };
}

// Property areas every scan must grade — a complete assessment, not just a
// list of problems. Rendered as chips in the app and a grid on the SOW PDF.
export const SCAN_AREAS = [
  "roof", "exterior", "kitchen", "bathrooms", "flooring", "paint_walls",
  "windows", "hvac", "plumbing", "electrical", "yard", "foundation_structure",
];
export const AREA_GRADES = ["good", "fair", "dated", "poor", "not_visible"];

// Schema is built per scan: when the bathroom/bedroom counts are known, the
// model is FORCED to grade exactly that many rooms (it used to skip rooms not
// shown in photos), and every area must be graded exactly once.
// NOTE: the structured-output API rejects minItems > 1 on arrays, so exact
// counts are enforced with objects whose keys are all required (bathroom_1…N,
// one key per area). scanRehabFromPhotos normalizes them back to the arrays
// the app expects.
const roomEntrySchema = (tiers) => ({
  type: "object",
  additionalProperties: false,
  required: ["tier", "note"],
  properties: {
    tier: { type: "string", enum: tiers.map((t) => t.id) },
    note: { type: "string" },
  },
});

const roomsSchema = (tiers, count, noun) =>
  count > 0
    ? {
        type: "object",
        additionalProperties: false,
        description: `One entry per ${noun}, in photo order`,
        required: Array.from({ length: count }, (_, i) => `${noun}_${i + 1}`),
        properties: Object.fromEntries(
          Array.from({ length: count }, (_, i) => [`${noun}_${i + 1}`, roomEntrySchema(tiers)])
        ),
      }
    : {
        type: "array",
        description: `One entry per ${noun} visible in the photos, in order`,
        items: roomEntrySchema(tiers),
      };

function makeScanSchema({ bathCount = 0, bedCount = 0 } = {}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "items", "bathrooms", "bedrooms", "areas", "custom"],
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
      bathrooms: roomsSchema(BATH_TIERS, bathCount, "bathroom"),
      bedrooms: roomsSchema(BED_TIERS, bedCount, "bedroom"),
      areas: {
        type: "object",
        additionalProperties: false,
        description: "Condition grade for every area of the property",
        required: [...SCAN_AREAS],
        properties: Object.fromEntries(SCAN_AREAS.map((a) => [a, {
          type: "object",
          additionalProperties: false,
          required: ["grade", "note"],
          properties: {
            grade: { type: "string", enum: AREA_GRADES },
            note: { type: "string", description: "Short evidence note, one sentence" },
          },
        }])),
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
}

const SYSTEM_PROMPT =
  "You are an experienced residential rehab estimator for a house-flipping / wholesaling operation. " +
  "You review MLS listing photos and produce a conservative, evidence-based scope of work for a mid-grade " +
  "rental/flip finish level (not luxury). Rules: only include work the photos actually show is needed — do not " +
  "assume hidden problems; if a room looks recently updated, it needs no work. Prefer the cheapest catalog item " +
  "that addresses what you see (e.g. cabinet reface over new cabinets when boxes look sound). MLS photos flatter " +
  "the property, so when a finish looks dated-but-borderline, lean toward including a refresh-level item. Systems " +
  "(roof, HVAC, water heater, electrical) only when visibly aged or damaged in the photos. " +
  "Grade every listed area of the property, including areas that need no work, and estimate the age of the " +
  "finishes in each. Explicitly flag any water staining, mold, or structural concerns you can see. Use the stated " +
  "square footage to size flooring and paint quantities. Cross-check listing-remark claims (e.g. 'updated 2023') " +
  "against what the photos actually show — the photos win. Be explicit in notes about what you could not see. " +
  "Half bathrooms count as bathrooms — grade them with the appropriate (usually cheaper) tier.";

// Run the scan. settings must carry aiApiKey; subject: {beds, baths, sqft, yearBuilt}.
export async function scanRehabFromPhotos({ photos, listing, subject, aiApiKey }) {
  const client = new Anthropic({ apiKey: aiApiKey });

  const catalogText = ALL_REHAB_ITEMS
    .map((i) => `- ${i.id}: ${i.label} (${i.mode === "sqft" ? `$${i.unit}/sqft` : i.mode === "qty" ? `$${i.unit} each` : `$${i.unit}`})`)
    .join("\n");
  const yearBuilt = Number(subject?.yearBuilt) || 0;
  const age = yearBuilt ? new Date().getFullYear() - yearBuilt : 0;
  const facts = [
    subject?.beds ? `${subject.beds} bedrooms` : null,
    subject?.baths ? `${subject.baths} bathrooms` : null,
    subject?.sqft ? `${subject.sqft} sqft` : null,
    yearBuilt ? `built ${yearBuilt} (${age} years old)` : null,
    listing?.listPrice ? `listed at $${Number(listing.listPrice).toLocaleString()}` : null,
  ].filter(Boolean).join(", ");
  const bathCount = Math.ceil(Number(subject?.baths)) || 0;
  const bedCount = Math.round(Number(subject?.beds)) || 0;

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

  const roomInstructions = [
    yearBuilt
      ? `Given the ${yearBuilt} build year, expect original-era systems (roof, HVAC, electrical, plumbing) unless the photos or remarks show updates.`
      : "",
    bathCount > 0
      ? `The property has ${bathCount} bathroom${bathCount > 1 ? "s" : ""} — assess EVERY one separately, in the order they appear in the photos. ` +
        `If a bathroom is not shown, grade it to match the overall interior condition trend (refresh if the rest of the interior is dated, ` +
        `none if the house is clearly renovated throughout) and say "not shown in photos" in its note.`
      : "",
    bedCount > 0
      ? `The property has ${bedCount} bedroom${bedCount > 1 ? "s" : ""} — assess every one the same way.`
      : "",
    `Also grade each of these areas (one entry per area, in this order): ${SCAN_AREAS.join(", ")}. ` +
    `Use "not_visible" when the photos don't show it.`,
  ].filter(Boolean).join("\n");

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
        `${roomInstructions}\n\n` +
        `Produce the rehab scope of work.`,
    },
  ];

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: makeScanSchema({ bathCount, bedCount }) } },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error("AI scan output truncated — try again"), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("AI scan was declined"), { http: 502 });
  }
  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(text);
  // Count-enforced rooms/areas come back as keyed objects (see makeScanSchema)
  // — normalize to the arrays the app and PDF expect.
  const roomList = (v) =>
    Array.isArray(v)
      ? v
      : v && typeof v === "object"
      ? Object.keys(v)
          .sort((a, b) => (parseInt(a.split("_").pop(), 10) || 0) - (parseInt(b.split("_").pop(), 10) || 0))
          .map((k) => v[k])
      : [];
  parsed.bathrooms = roomList(parsed.bathrooms);
  parsed.bedrooms = roomList(parsed.bedrooms);
  parsed.areas = Array.isArray(parsed.areas)
    ? parsed.areas
    : SCAN_AREAS.filter((a) => parsed.areas?.[a]).map((a) => ({ area: a, ...parsed.areas[a] }));
  return parsed;
}

/* ---------- comp condition grading (for ARV accuracy) ---------- */

export const COMP_CONDITIONS = ["renovated", "updated", "dated", "distressed", "unknown"];

const GRADE_SYSTEM_PROMPT =
  "You are a comp analyst for a house flipper, grading the renovation condition of SOLD comparable properties " +
  "AT THE TIME OF SALE from their listing photos and description. Grades: " +
  "renovated = full recent remodel with magazine/HGTV-ready finishes throughout; " +
  "updated = meaningful partial updates (kitchen or baths redone, newer flooring/paint) but not a full remodel; " +
  "dated = mostly original finishes 15+ years old; " +
  "distressed = visible damage, gut-level condition, or heavy deferred maintenance; " +
  "unknown = photos and description are insufficient to judge. " +
  "Weight kitchen and bathroom condition most heavily. Trust the photos over description claims. " +
  "Give exactly one grade per comp, with a note citing the decisive evidence.";

// Grade a batch of comps in one Claude call. Each comp: {id, address, price,
// sqft, beds, baths, saleDate, photos: [url...], description}. Returns
// { grades: [{id, condition, confidence, note}] } — one entry per comp,
// enforced by the schema.
export async function gradeCompConditions({ subjectAddress, comps, aiApiKey }) {
  const client = new Anthropic({ apiKey: aiApiKey });

  // One required key per comp id — the structured-output API rejects
  // minItems > 1 on arrays, and this enforces exactly-one-grade-per-comp
  // even harder than a fixed-length array would.
  const gradeEntrySchema = {
    type: "object",
    additionalProperties: false,
    required: ["condition", "confidence", "note"],
    properties: {
      condition: { type: "string", enum: COMP_CONDITIONS },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      note: { type: "string", description: "Decisive evidence, one sentence" },
    },
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["grades"],
    properties: {
      grades: {
        type: "object",
        additionalProperties: false,
        description: "One grade per comp, keyed by comp id",
        required: comps.map((c) => c.id),
        properties: Object.fromEntries(comps.map((c) => [c.id, gradeEntrySchema])),
      },
    },
  };

  const content = [];
  for (const c of comps) {
    const header = [
      `COMP ${c.id} — ${c.address}.`,
      c.saleDate || c.price ? `Sold${c.saleDate ? ` ${c.saleDate}` : ""}${c.price ? ` for $${Number(c.price).toLocaleString()}` : ""}.` : "",
      c.beds != null || c.sqft ? `${c.beds ?? "?"}/${c.baths ?? "?"} · ${c.sqft ? `${Number(c.sqft).toLocaleString()} sqft` : "sqft unknown"}.` : "",
      c.description ? `Listing description: "${String(c.description).slice(0, 800)}"` : "No listing description available.",
    ].filter(Boolean).join(" ");
    content.push({ type: "text", text: header });
    for (const url of (c.photos || []).slice(0, 6)) {
      content.push({ type: "image", source: { type: "url", url } });
    }
  }
  content.push({
    type: "text",
    text:
      `These ${comps.length} comps are being used to estimate the after-repair value of ${subjectAddress || "a subject property"}. ` +
      `Grade the renovation condition of each comp at its time of sale.`,
  });

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: GRADE_SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error("comp grading output truncated — try again"), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("comp grading was declined"), { http: 502 });
  }
  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(text);
  // Keyed object → the [{id, ...grade}] list the route expects.
  return { grades: Object.entries(parsed.grades || {}).map(([id, g]) => ({ id, ...g })) };
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
