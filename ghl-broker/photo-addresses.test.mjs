// photo-addresses.test.mjs — a flyer texted or emailed in is an address.
//
// Matt, 2026-10-22: an investor answered "send over the addresses" with two
// flyers (7413 Soundview Dr, Edmonds and 13645 3rd Ave S, Burien) and no
// words. The bot sent "Thanks for the images" and Matt typed both drafts by hand.
//
//   node --test photo-addresses.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentUrls, bodyImageUrls, inboundPhotoUrls, readPhotoAddresses, expandPhotoAddresses, photoMarkers, _resetPhotoCache, firstPages,
} from "./photo-addresses.js";
import { PDFDocument } from "pdf-lib";

const SOUNDVIEW = "7413 Soundview Dr, Edmonds, WA 98026";
const BURIEN = "13645 3rd Ave S, Burien, WA 98168";
const img = (n) => `https://static-assets.internal.usercontent.site/flyer-${n}.jpg`;
const block = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } };

test("the pictures a webhook carries are found whatever shape GHL sent them in, and a count carries none", () => {
  assert.deepEqual(attachmentUrls([img(1), { url: img(2) }]), [img(1), img(2)]);
  assert.deepEqual(attachmentUrls(JSON.stringify([img(1)])), [img(1)]);
  assert.deepEqual(attachmentUrls(`${img(1)}, ${img(2)}`), [img(1), img(2)]);
  assert.deepEqual(attachmentUrls(2), []);
  assert.deepEqual(attachmentUrls("https://x.site/clip.3gp"), [], "a video is not read");
});

test("pictures in an email body are read, the one-pixel open tracker isn't", () => {
  const html = `<p>See attached</p><img src="${img(1)}" alt="flyer"><img width="1" height="1" src="https://t.example.com/open.gif">`;
  assert.deepEqual(bodyImageUrls(html), [img(1)]);
});

test("the burst read back from GHL is every picture since our last text, oldest first", async () => {
  const now = Date.parse("2026-10-22T15:04:00Z");
  const client = { call: async (p) => p.includes("/conversations/search")
    ? { conversations: [{ id: "cv1" }] }
    : { messages: { messages: [
      { direction: "inbound", messageType: "TYPE_SMS", body: "", attachments: [img(3), img(4)], dateAdded: "2026-10-22T15:03:30Z" },
      { direction: "inbound", messageType: "TYPE_SMS", body: "", attachments: [img(1), img(2)], dateAdded: "2026-10-22T15:03:00Z" },
      { direction: "outbound", messageType: "TYPE_SMS", body: "Nice, send over the addresses", dateAdded: "2026-10-22T15:00:00Z" },
      { direction: "inbound", messageType: "TYPE_SMS", body: "", attachments: [img(9)], dateAdded: "2026-10-22T14:58:00Z" },
    ] } } };
  assert.deepEqual(await inboundPhotoUrls(client, "LOC", "c1", { now }), [img(1), img(2), img(3), img(4)]);
});

test("each flyer's printed address comes back once, and a picture already read isn't paid for twice", async () => {
  _resetPhotoCache();
  let asks = 0;
  const deps = {
    load: async (urls) => urls.map(() => block),
    ask: async (blocks) => {
      asks++;
      return blocks.length === 4
        ? [{ image: 2, address: SOUNDVIEW }, { image: 4, address: BURIEN }, { image: 1, address: "Bothell" }]
        : [];
    },
  };
  assert.deepEqual(await readPhotoAddresses([img(1), img(2), img(3), img(4)], { deps }), [SOUNDVIEW, BURIEN], "a city with no house number is not an address");
  assert.deepEqual(await readPhotoAddresses([img(3), img(4)], { deps }), [BURIEN]);
  assert.equal(asks, 1);
});

test("a picture with no address, or a sheet of a dozen comps, adds nothing", async () => {
  _resetPhotoCache();
  const load = async (urls) => urls.map(() => block);
  assert.deepEqual(await readPhotoAddresses([img(5)], { deps: { load, ask: async () => [] } }), []);
  const comps = Array.from({ length: 6 }, (_, i) => ({ image: 1, address: `${100 + i} Elm St, Kent, WA 98031` }));
  assert.deepEqual(await readPhotoAddresses([img(6)], { deps: { load, ask: async () => comps } }), []);
});

test("the addresses lead the message, once each", () => {
  const once = expandPhotoAddresses("", [SOUNDVIEW, BURIEN]);
  assert.equal(once, `[photo → ${SOUNDVIEW}]\n[photo → ${BURIEN}]`);
  assert.equal(expandPhotoAddresses(once, [BURIEN]), once);
  assert.deepEqual(photoMarkers(`${expandPhotoAddresses("Two more for you", [SOUNDVIEW])}`), [SOUNDVIEW]);
});

/* ---------- an email's PDFs (2026-10-22) ---------- */
// A listing agent answered our outreach email with the inspection report and
// the appraisal attached. GHL's message list holds an email as a stub (no
// body, no attachments, no direction) with the real emails in
// meta.email.messageIds, our outreach and their reply in one stub, so the
// read-back stopped at the stub and found nothing.

test("an agent's emailed PDFs are found, though GHL's message list shows the email as an empty stub", async () => {
  const now = Date.parse("2026-10-22T14:20:00Z");
  const pdfs = ["https://static-assets.internal.usercontent.site/c/inspection.pdf", "https://static-assets.internal.usercontent.site/c/appraisal.pdf"];
  const emails = {
    out1: { id: "out1", direction: "outbound", dateAdded: "2026-10-22T02:23:25Z", body: "Hi, any fixers on your radar?", attachments: [] },
    in1: { id: "in1", direction: "inbound", dateAdded: "2026-10-22T14:10:00Z", body: "<p>Attached the inspection and appraisal.</p>", attachments: pdfs },
  };
  const client = { call: async (p) => {
    if (p.includes("/conversations/search")) return { conversations: [{ id: "cv1" }] };
    const m = /messages\/email\/(\w+)/.exec(p);
    if (m) return { emailMessage: emails[m[1]] };
    return { messages: { messages: [
      { id: "s1", messageType: "TYPE_EMAIL", dateAdded: "2026-10-22T02:23:25Z", meta: { email: { messageIds: ["out1", "in1"], direction: "inbound" } } },
    ] } };
  } };
  assert.deepEqual(await inboundPhotoUrls(client, "LOC", "c1", { now }), pdfs);
});

test("an 81-page inspection report is read by its cover pages only", async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 81; i++) doc.addPage();
  const cut = await PDFDocument.load(await firstPages(Buffer.from(await doc.save())));
  assert.equal(cut.getPageCount(), 2);
});
