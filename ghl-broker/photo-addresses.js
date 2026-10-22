// photo-addresses.js — a flyer texted in is an address.
//
// Matt, 2026-10-22: "Are we able to scrub images that people sent over and
// create the drafts from the address(es) that are in the image? I have to go
// in and grab the address from each of the things that the person sends and
// manually create the draft." Agents and wholesalers answer "send over the
// addresses" with marketing flyers and listing screenshots: the address is
// printed on the picture, and the text is empty.
//
// This is the photo twin of listing-links.js. The pictures are read for one
// thing only, the street address printed on them, and each address is
// written back into the message as "[photo → address]". Every later reader
// (the reply model, skeleton drafts, the underwriter) sees a house exactly as
// if they had typed it. The model writing the reply never sees the picture,
// so the old rule still holds: we never describe what's in someone's photo.
//
// Off unless conversationAi.media.readAddresses is on. A photo with no
// printed address (a kitchen, a yard) reads as nothing, and the canned
// photo line goes back as before.
//
// Texts and emails alike (Matt: "both in texts and emails sent"). An email
// brings its flyer as an attached picture, an attached PDF, or a picture
// placed in the body; all three are read. Links in either are listing-links.js.

import Anthropic from "@anthropic-ai/sdk";
import { VISION_MODEL, anthropicErrorToHttp } from "./rehab-scan.js";
import { meterAi } from "./ai-spend.js";
import { hasHouseNumber } from "./shared/mentioned-houses.js";
import { addressKey } from "./shared/us-address.js";
import { searchConversations, listConversationMessages } from "./ghl.js";
import { PDFDocument } from "pdf-lib";

// A burst of flyers is two or three texts of one or two pictures each.
export const MAX_PHOTOS = 8;
// More than this off one burst is a comps sheet or a list, not houses sent to us.
export const MAX_ADDRESSES = 4;
// Only the texts since our last one, and only this recent.
const WINDOW_MS = 30 * 60 * 1000;
const NOT_A_PICTURE = /\.(3gpp?|mp4|mov|m4a|amr|wav|mp3|vcf|docx?|xlsx?|zip|ics)(\?|$)/i;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const MARKER_RE = /\[photo → ([^\]\n]{5,200})\]/g;

/** photoMarkers(text) → the addresses already written into a message, in order. */
export function photoMarkers(text = "") {
  return [...String(text || "").matchAll(MARKER_RE)].map((m) => m[1].trim());
}

/**
 * attachmentUrls(v) → the picture URLs a webhook body carried, whatever shape
 * it took: a list of URLs or of { url }, a JSON-encoded list, or one string of
 * URLs separated by spaces or commas. A count carries none.
 */
export function attachmentUrls(v) {
  if (v == null || v === false || typeof v === "number") return [];
  let list = v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) {
      try { list = JSON.parse(t); } catch { list = t.split(/[\s,]+/); }
    } else {
      list = t.split(/[\s,]+/);
    }
  }
  if (!Array.isArray(list)) list = [list];
  const urls = list
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? x.url || x.href || x.link || "" : ""))
    .map((s) => String(s).trim())
    .filter((s) => /^https?:\/\//i.test(s) && !NOT_A_PICTURE.test(s));
  return [...new Set(urls)].slice(0, MAX_PHOTOS);
}

/**
 * bodyImageUrls(html) → the pictures placed in an email body (<img src>),
 * not the 1-pixel open trackers. Logos and signature pictures come along and
 * read as no address.
 */
export function bodyImageUrls(html = "") {
  const out = [];
  for (const m of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || "";
    if (/\b(?:width|height)\s*=\s*["']?[0-2]["'\s/>]/i.test(tag)) continue;
    out.push(src.replace(/&amp;/g, "&"));
  }
  return attachmentUrls(out);
}

/**
 * inboundPhotoUrls(client, locationId, contactId, { now }) → picture URLs
 *
 * Every picture they've texted since our last text, newest conversation only,
 * oldest first. A webhook may carry only a count, and a second photo text
 * replaces the first one's waiting reply (the debounce), so the burst is read
 * back from GHL rather than trusted to one webhook. Needs conversations.readonly.
 */
export async function inboundPhotoUrls(client, locationId, contactId, { now = Date.now() } = {}) {
  const { conversations } = await searchConversations(client, locationId, { contactId, limit: 1 });
  const c = conversations[0];
  if (!c) return [];
  // Emails come back whole (ghl.js withEmails): their attachments, and the
  // pictures in the reply's own words.
  const { messages } = await listConversationMessages(client, c.id, { limit: 25 });
  const out = [];
  for (const m of messages) {
    if (/ACTIVITY/i.test(String(m.messageType || m.type || ""))) continue;
    if (String(m.direction || "").toLowerCase() !== "inbound") break;
    const ts = Date.parse(m.dateAdded || "");
    if (Number.isFinite(ts) && now - ts > WINDOW_MS) break;
    out.unshift(...attachmentUrls(m.attachments), ...(/EMAIL/i.test(String(m.messageType || m.type || "")) ? bodyImageUrls(m.body) : []));
  }
  return [...new Set(out)].slice(-MAX_PHOTOS);
}

const SYSTEM = [
  "You read pictures and PDFs a real-estate agent or investor texted or emailed us: marketing flyers, listing screenshots, MLS sheets, a photo of a for-sale sign.",
  "Your only job is the street address of each house a picture is about, the property being advertised or shown.",
  "Copy the address exactly as printed: house number and street, then city, state and ZIP when they are printed.",
  "Never guess, complete or correct an address. A street with no house number is not an address.",
  "Skip an office, a brokerage, a return address, a lender, and the addresses in a list of comparable sales.",
  "A photo of a room, a yard or the outside of a house with no printed address has none.",
  "Return every address with the number of the picture or PDF it is printed on (numbered from 1 in the order given). An empty list is a normal answer.",
].join(" ");

const SCHEMA = {
  type: "object",
  properties: {
    addresses: {
      type: "array",
      items: {
        type: "object",
        properties: { image: { type: "integer" }, address: { type: "string" } },
        required: ["image", "address"],
        additionalProperties: false,
      },
    },
  },
  required: ["addresses"],
  additionalProperties: false,
};

// url → { at, addresses }. A burst read twice (a second photo text replaces
// the first one's waiting reply) pays for each picture once.
const CACHE_TTL_MS = 6 * 3600 * 1000;
const cache = new Map();
export function _resetPhotoCache() { cache.clear(); }

async function askModel(blocks, aiApiKey) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 60_000 });
  const content = [];
  blocks.forEach((b, i) => content.push({ type: "text", text: `Picture ${i + 1}:` }, b));
  content.push({ type: "text", text: "The printed street address of each house these pictures are about." });
  let response;
  try {
    response = await client.beta.messages.create({
      model: VISION_MODEL,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    });
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  meterAi("photo_addresses", response, { model: VISION_MODEL });
  if (response.stop_reason === "max_tokens" || response.stop_reason === "refusal") return [];
  const raw = response.content.find((b) => b.type === "text")?.text || "{}";
  const { addresses } = JSON.parse(raw);
  return Array.isArray(addresses) ? addresses : [];
}

// The address is on the cover. An inspection report runs 80 pages and an
// appraisal lists its comps' addresses, so only the first pages are read:
// cheaper, and no comps to mistake for houses sent to us.
const PDF_PAGES = 2;
export async function firstPages(buf, pages = PDF_PAGES) {
  try {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    if (src.getPageCount() <= pages) return buf;
    const out = await PDFDocument.create();
    for (const p of await out.copyPages(src, [...Array(pages).keys()])) out.addPage(p);
    return Buffer.from(await out.save());
  } catch (e) {
    // Unreadable to trim: a small one goes whole, a big one not at all.
    if (buf.length > 5 * 1024 * 1024) throw e;
    return buf;
  }
}

// One attachment as a content block: a picture, or a PDF as a document,
// by what the server says it is (GHL's file links often carry no extension).
// Null when it can't be fetched or is neither.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
async function loadBlock(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const type = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const pdf = type === "application/pdf" || (type === "application/octet-stream" && /\.pdf(\?|$)/i.test(url));
    if (!pdf && !IMAGE_TYPES.has(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > (pdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) return null;
    return pdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: (await firstPages(buf)).toString("base64") } }
      : { type: "image", source: { type: "base64", media_type: type, data: buf.toString("base64") } };
  } catch { return null; }
}

/**
 * readPhotoAddresses(urls, { aiApiKey, now, deps }) → ["7413 Soundview Dr, Edmonds, WA 98026", …]
 *
 * The addresses printed on the pictures, one per house, in picture order.
 * deps.load (urls → image blocks) and deps.ask (blocks → [{ image, address }])
 * stand in for the downloads and the model call in tests.
 */
export async function readPhotoAddresses(urls = [], { aiApiKey = "", now = Date.now(), deps = {} } = {}) {
  const list = [...new Set(urls)].slice(0, MAX_PHOTOS);
  if (!list.length) return [];
  const fresh = (u) => { const c = cache.get(u); return c && now - c.at < CACHE_TTL_MS; };
  const unread = list.filter((u) => !fresh(u));
  if (unread.length) {
    const load = deps.load || ((us) => Promise.all(us.map(loadBlock)));
    const blocks = await load(unread);
    // The API takes 32MB a request; base64 is a third bigger than the file.
    let used = 0;
    const loaded = unread.map((u, i) => ({ url: u, block: blocks[i] })).filter((x) => {
      if (!x.block) return false;
      used += String(x.block.source?.data || "").length;
      return used <= 24 * 1024 * 1024;
    });
    const found = loaded.length ? await (deps.ask || askModel)(loaded.map((x) => x.block), aiApiKey) : [];
    for (const x of loaded) cache.set(x.url, { at: now, addresses: [] });
    for (const f of found) {
      const hit = loaded[(Number(f?.image) || 0) - 1];
      const address = String(f?.address || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!hit || !address || !hasHouseNumber(address)) continue;
      cache.get(hit.url).addresses.push(address);
    }
  }
  const out = [];
  const seen = new Set();
  for (const u of list) {
    for (const a of cache.get(u)?.addresses || []) {
      const k = addressKey(a);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
  }
  return out.length > MAX_ADDRESSES ? [] : out;
}

/**
 * expandPhotoAddresses(text, addresses) → the message led by one
 * "[photo → address]" line per address it doesn't already carry.
 */
export function expandPhotoAddresses(text = "", addresses = []) {
  const raw = String(text || "").trim();
  const have = new Set(photoMarkers(raw).map(addressKey));
  const lines = addresses.filter((a) => !have.has(addressKey(a))).map((a) => `[photo → ${a}]`);
  // First, so a long email cut to fit (the underwriter keeps 500 characters)
  // never loses them.
  return lines.length ? [...lines, raw].filter(Boolean).join("\n") : raw;
}
