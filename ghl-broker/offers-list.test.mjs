// offers-list.test.mjs — opening the Offers page reads drafts lightly and
// keeps its answer a minute, without the answer changing.
//
// GET /api/offers?activity=1&next=1 used to read the location's 4,000 newest
// reply drafts whole (~10KB each, mostly prompt context) on every load of
// Matt's main page. The columns it feeds read a dozen fields. These tests pin
// that the trimmed read gives the same Next follow-up, Last activity and
// Floated stamps as the whole one, on a fixture that leans on every field the
// trim keeps (updatedAt on a sent draft, the words of an inbound text, a draft
// a person answered by hand). Every name, id and text here is invented.
//
//   node --test offers-list.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offers-list-test-"));
delete process.env.DATABASE_URL;
const { store, draftActivityRow, draftActivityQuery, DRAFT_ACTIVITY_FIELDS, DRAFT_ACTIVITY_OUTBOUND, offerWriteGeneration } = await import("./store.js");
const { attachOfferListColumns, createOffersListCache, readOfferListDrafts } = await import("./offers-list.js");
const { attachNextFollowUps } = await import("./next-follow-up.js");
const { LAST_ACTIVITY_TYPES, lastActivityFromEvents, mergeDraftActivity, mergeGhlActivity } = await import("./shared/last-activity.js");
const { floatSentIndex } = await import("./shared/paper-follows.js");
const { annotateCurrent } = await import("./shared/current-offer.js");

test.after(async () => { await new Promise((r) => setTimeout(r, 120)); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const LOC = "loc-offers-list";
const NOW = Date.parse("2026-11-20T18:00:00.000Z");
const HOUR = 3600000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW - ms).toISOString();
const ahead = (ms) => new Date(NOW + ms).toISOString();
// What makes a whole draft heavy: the prompt context and the model's notes.
const FAT = { context: { thread: "x".repeat(6000), house: "y".repeat(2000) }, prompt: "z".repeat(1500), notes: "n".repeat(500) };

async function seedOffer(doc) {
  const made = await store.createOffer({ locationId: LOC, ...doc });
  const full = { ...made, createdAt: doc.createdAt || made.createdAt };
  await store.updateOffer(made.id, full);
  return full;
}
async function seedDraft(doc) {
  const made = await store.createReplyDraft({ locationId: LOC, ...FAT, ...doc });
  const full = { ...made, createdAt: doc.createdAt, updatedAt: doc.updatedAt || doc.createdAt };
  await store.updateReplyDraft(made.id, full);
  return full;
}

// The route as it was before 2026-11-23: whole drafts, no window.
async function wholeDraftColumns({ offers, ghl = new Map() }) {
  const drafts = await store.listReplyDrafts(LOC, { limit: 4000 }).catch(() => []);
  const rows = await store.lastContactActivity(LOC, { types: LAST_ACTIVITY_TYPES }).catch(() => []);
  const seen = mergeDraftActivity(lastActivityFromEvents(rows), drafts);
  mergeGhlActivity(seen, ghl, [...new Set(offers.map((o) => o?.contactId).filter(Boolean))]);
  for (const o of offers) if (o?.contactId) o.lastActivity = seen.get(o.contactId) || null;
  const floats = floatSentIndex(drafts);
  for (const o of offers) if (o?.id) o.floatedAt = floats.get(o.id) || null;
  const saved = (await store.getOfferSettings(LOC)) || {};
  await attachNextFollowUps({ store, locationId: LOC, saved, offers, drafts, now: NOW });
  return offers;
}

const readBook = async () => annotateCurrent(await store.listOffers(LOC, { limit: 2000, lean: true }));
const columns = (offers) => Object.fromEntries(offers.map((o) => [o.id, { next: o.nextFollowUp, last: o.lastActivity, floatedAt: o.floatedAt }]));

let seeded = null;
async function seed() {
  if (seeded) return seeded;
  const ids = {};
  // The ladders on, as in production: the nudge re-anchors and asks threadHealth.
  await store.saveOfferSettings(LOC, { conversationAi: {
    enabled: true,
    parties: { agent: {
      followUp: { enabled: true, ladders: {
        offer_nudge: { enabled: true, steps: [3, 7, 14], repeatEvery: 7 },
        passed_checkin: { enabled: true, steps: [10, 20, 30] },
        hot_push: { enabled: true, steps: [1, 3, 6, 10] },
      } },
      autoSend: { enabled: true, intents: ["offer_nudge", "passed_checkin", "hot_push", "checkin_due"] },
    } },
  } });
  // An offer out three weeks; a nudge went (stamped sent by updatedAt only),
  // they wrote back, we answered. And one draft from long before the window.
  ids.answered = (await seedOffer({ contactId: "c-answered", address: "101 Test Ave, Testville, WA 98000", status: "sent",
    sends: [{ ts: ago(21 * DAY), channel: "sms" }], pdfUrl: "https://example.test/a.pdf", createdAt: ago(22 * DAY) })).id;
  await seedDraft({ contactId: "c-answered", status: "sent", createdAt: ago(200 * DAY), sentAt: ago(200 * DAY), inbound: "an old text" });
  await seedDraft({ contactId: "c-answered", status: "sent", createdAt: ago(12 * DAY), updatedAt: ago(11 * DAY),
    outbound: { kind: "offer_nudge", offerId: ids.answered, text: "invented nudge", step: 7 } });
  await seedDraft({ contactId: "c-answered", status: "sent", createdAt: ago(5 * DAY), sentAt: ago(5 * DAY - HOUR), inbound: "still thinking it over", intent: "question", autoSent: true });

  // Our number floated by text (a sent realm check), nothing on the offer.
  ids.floated = (await seedOffer({ contactId: "c-floated", address: "202 Test Ave, Testville, WA 98000", status: "new",
    calc: { cash: 300000 }, createdAt: ago(6 * DAY) })).id;
  await seedDraft({ contactId: "c-floated", status: "sent", createdAt: ago(3 * DAY), updatedAt: ago(3 * DAY),
    outbound: { kind: "realm_check", offerId: ids.floated, text: "invented float" } });

  // Their text is waiting on a person.
  ids.held = (await seedOffer({ contactId: "c-held", address: "303 Test Ave, Testville, WA 98000", status: "sent",
    sends: [{ ts: ago(9 * DAY) }], pdfUrl: "https://example.test/b.pdf", createdAt: ago(10 * DAY) })).id;
  await seedDraft({ contactId: "c-held", status: "draft", createdAt: ago(1 * DAY), inbound: "what about the roof", intent: "question" });

  // Something already queued.
  ids.queued = (await seedOffer({ contactId: "c-queued", address: "404 Test Ave, Testville, WA 98000", status: "sent",
    sends: [{ ts: ago(8 * DAY) }], pdfUrl: "https://example.test/c.pdf", createdAt: ago(8 * DAY) })).id;
  await seedDraft({ contactId: "c-queued", status: "scheduled", createdAt: ago(2 * HOUR), sendAt: ahead(20 * HOUR),
    outbound: { kind: "offer_nudge", offerId: ids.queued, text: "invented queued nudge" } });

  // They opted out in a text.
  ids.optedOut = (await seedOffer({ contactId: "c-opted", address: "505 Test Ave, Testville, WA 98000", status: "sent",
    sends: [{ ts: ago(15 * DAY) }], pdfUrl: "https://example.test/d.pdf", createdAt: ago(15 * DAY) })).id;
  await seedDraft({ contactId: "c-opted", status: "dismissed", createdAt: ago(4 * DAY), inbound: "please remove me", intent: "opt_out" });

  // Annoyed, after we answered: the nudge re-anchors and threadHealth reads
  // the words of their newest texts.
  ids.annoyed = (await seedOffer({ contactId: "c-annoyed", address: "606 Test Ave, Testville, WA 98000", status: "sent",
    sends: [{ ts: ago(30 * DAY) }], pdfUrl: "https://example.test/e.pdf", createdAt: ago(30 * DAY) })).id;
  await seedDraft({ contactId: "c-annoyed", status: "sent", createdAt: ago(9 * DAY), sentAt: ago(9 * DAY),
    inbound: "how many times do I have to say it", intent: "question" });

  // A person answered by hand two days ago, on a draft made ten days ago:
  // only updatedAt says it is recent.
  ids.byHand = (await seedOffer({ contactId: "c-hand", address: "707 Test Ave, Testville, WA 98000", status: "sent",
    sends: [{ ts: ago(25 * DAY) }], pdfUrl: "https://example.test/f.pdf", createdAt: ago(25 * DAY) })).id;
  await seedDraft({ contactId: "c-hand", status: "sent", createdAt: ago(10 * DAY), updatedAt: ago(2 * DAY), sentAt: ago(2 * DAY),
    inbound: "send me the comps", intent: "question", answeredBy: "you" });

  // Last heard only on the timeline, and from GHL.
  ids.timeline = (await seedOffer({ contactId: "c-timeline", address: "808 Test Ave, Testville, WA 98000", status: "sent",
    sends: [{ ts: ago(4 * DAY) }], pdfUrl: "https://example.test/g.pdf", createdAt: ago(4 * DAY) })).id;
  await store.appendContactEvents(LOC, "c-timeline", [{ type: "text_summary", at: ago(3 * DAY), data: { inbound: "sounds good" } }]);

  seeded = ids;
  return ids;
}

test("opening offers shows the same next follow-up while reading a fraction of the drafts", async () => {
  await seed();
  const ghl = new Map([["c-timeline", { at: ago(1 * DAY), dir: "out" }]]);

  const before = await wholeDraftColumns({ offers: await readBook(), ghl });

  // What each read hands back, in bytes.
  const bytes = { whole: 0, trimmed: 0 };
  const whole = store.listReplyDrafts;
  const trimmed = store.listReplyDraftActivity;
  store.listReplyDrafts = async (...a) => { const r = await whole.apply(store, a); bytes.whole += JSON.stringify(r).length; return r; };
  store.listReplyDraftActivity = async (...a) => { const r = await trimmed.apply(store, a); bytes.trimmed += JSON.stringify(r).length; return r; };
  let after;
  try {
    after = await attachOfferListColumns({ store, locationId: LOC, offers: await readBook(), activity: true, next: true,
      ghlLastMessages: async () => ghl, now: NOW });
  } finally {
    store.listReplyDrafts = whole;
    store.listReplyDraftActivity = trimmed;
  }

  assert.deepEqual(columns(after), columns(before));
  assert.equal(bytes.whole, 0, "no whole draft is read");
  const wholeBytes = JSON.stringify(await store.listReplyDrafts(LOC, { limit: 4000 })).length;
  assert.ok(bytes.trimmed > 0 && bytes.trimmed * 10 < wholeBytes, `trimmed ${bytes.trimmed}B against ${wholeBytes}B whole`);

  // The fixture reaches the branches the trim could break.
  const kinds = Object.fromEntries(after.map((o) => [o.contactId, o.nextFollowUp?.kind]));
  assert.equal(kinds["c-held"], "reply_owed");
  assert.equal(kinds["c-queued"], "queued");
  assert.equal(kinds["c-opted"], "stopped");
  const reason = (c) => after.find((o) => o.contactId === c).nextFollowUp?.reason;
  assert.match(reason("c-annoyed"), /annoyed/, "the words of their text are read");
  assert.match(reason("c-hand"), /you have the thread/, "a person's answer two days ago is seen");
  assert.equal(kinds["c-answered"], "offer_nudge");
  assert.equal(after.find((o) => o.contactId === "c-answered").lastActivity?.machine, true, "the bot's own reply reads as the machine");
  assert.ok(after.find((o) => o.contactId === "c-floated").floatedAt, "the float by text is found");
  assert.equal(after.find((o) => o.contactId === "c-timeline").lastActivity?.source, "ghl");
});

test("the next follow-up read on its own (Line) gives the same answer trimmed as whole", async () => {
  await seed();
  const saved = (await store.getOfferSettings(LOC)) || {};
  const viaTrim = await attachNextFollowUps({ store, locationId: LOC, saved, offers: await readBook(), now: NOW });
  const since = new Date(NOW - 130 * DAY).toISOString();
  const wholeDrafts = await store.listReplyDrafts(LOC, { since, limit: 4000 });
  const viaWhole = await attachNextFollowUps({ store, locationId: LOC, saved, offers: await readBook(), drafts: wholeDrafts, now: NOW });
  assert.deepEqual(viaTrim.map((o) => o.nextFollowUp), viaWhole.map((o) => o.nextFollowUp));
});

test("the trimmed draft keeps every field the columns read, off the doc, and nothing heavy", () => {
  const row = draftActivityRow({
    id: "d1", locationId: LOC, contactId: "c1", status: "sent", createdAt: ago(DAY), updatedAt: ago(HOUR), sentAt: ago(HOUR),
    sendAt: null, autoSent: false, intent: "question", answeredBy: "you", inbound: "a question",
    outbound: { kind: "offer_nudge", offerId: "o1", text: "invented", step: 3 }, ...FAT,
  });
  assert.deepEqual(row, {
    id: "d1", locationId: LOC, contactId: "c1", status: "sent", createdAt: ago(DAY), updatedAt: ago(HOUR), sentAt: ago(HOUR),
    autoSent: false, intent: "question", answeredBy: "you", inbound: "a question",
    outbound: { kind: "offer_nudge", offerId: "o1" },
  });
  assert.deepEqual(draftActivityRow({ id: "d2" }), { id: "d2" });
});

test("the Postgres read asks for the same fields as the file read, with every value bound", () => {
  for (const opts of [{ locationId: LOC }, { locationId: LOC, since: ago(DAY), limit: 4000 }]) {
    const { text, params } = draftActivityQuery(opts);
    const seen = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual([...new Set(seen)].sort((a, b) => a - b), params.map((_, i) => i + 1));
    assert.doesNotMatch(text, /limit \d/);
    for (const k of DRAFT_ACTIVITY_FIELDS) assert.match(text, new RegExp(`'${k}', doc->'${k}'`), k);
    for (const k of DRAFT_ACTIVITY_OUTBOUND) assert.match(text, new RegExp(`'${k}', doc #> '\\{outbound,${k}\\}'`), k);
    assert.doesNotMatch(text, /select doc\b/, "never the whole doc");
  }
});

test("the offers read uses the next follow-up's window", async () => {
  let asked = null;
  await readOfferListDrafts({ store: { listReplyDraftActivity: async (loc, opts) => { asked = opts; return []; } }, locationId: LOC, now: NOW });
  assert.equal(asked.since, new Date(NOW - 130 * DAY).toISOString());
  assert.equal(asked.limit, 4000);
});

test("a reload within the minute is answered from memory, and two at once read once", async () => {
  let t = 0;
  let reads = 0;
  const cache = createOffersListCache({ ttlMs: 60000, generation: () => 0, clock: () => t });
  const compute = async () => { reads++; await new Promise((r) => setTimeout(r, 5)); return { n: reads }; };
  const [a, b] = await Promise.all([cache.remember("loc", compute), cache.remember("loc", compute)]);
  assert.equal(reads, 1);
  assert.equal(a, b);
  t = 59000;
  assert.equal((await cache.remember("loc", compute)).n, 1);
  t = 60001;
  assert.equal((await cache.remember("loc", compute)).n, 2);
  assert.equal((await cache.remember("other-loc", compute)).n, 3, "each location keeps its own");
});

test("an offer written drops the kept answer at once", async () => {
  await seed();
  const cache = createOffersListCache({ ttlMs: 60000, generation: offerWriteGeneration });
  let reads = 0;
  const compute = async () => ++reads;
  assert.equal(await cache.remember(LOC, compute), 1);
  assert.equal(await cache.remember(LOC, compute), 1);
  const o = await store.getOffer(seeded.held);
  await store.updateOffer(o.id, { ...o, status: "no_response" });
  assert.equal(await cache.remember(LOC, compute), 2, "updateOffer");
  await store.createOffer({ locationId: LOC, contactId: "c-new", address: "909 Test Ave, Testville, WA 98000" }).then((n) => store.deleteOffer(n.id));
  assert.equal(await cache.remember(LOC, compute), 3, "createOffer and deleteOffer");
  await store.updateOffer(o.id, o);
});

test("a write that lands while the answer is being read leaves it stale", async () => {
  let gen = 0;
  const cache = createOffersListCache({ ttlMs: 60000, generation: () => gen });
  let reads = 0;
  const first = await cache.remember("loc", async () => { reads++; gen++; return "read before the write settled"; });
  assert.equal(first, "read before the write settled");
  assert.equal(await cache.remember("loc", async () => { reads++; return "fresh"; }), "fresh");
  assert.equal(reads, 2);
});

test("a read that fails is not kept", async () => {
  const cache = createOffersListCache({ ttlMs: 60000 });
  await assert.rejects(cache.remember("loc", async () => { throw new Error("db down"); }));
  assert.equal(await cache.remember("loc", async () => "ok"), "ok");
});

test("the Offers page's load is kept a minute, and an offer written shows on the next load", async () => {
  const { default: express } = await import("express");
  const { default: createOffersRouter } = await import("./routes/offers.js");
  const ROUTE_LOC = "loc-offers-list-route";
  const app = express();
  app.use(express.json());
  app.use("/api/offers", createOffersRouter({
    resolveLocation: () => ({ locationId: ROUTE_LOC, client: { call: async () => ({}) } }),
    uploadDir: process.env.DATA_DIR,
    publicBaseUrl: "http://127.0.0.1:1",
  }));
  const server = app.listen(0);
  try {
    const B = `http://127.0.0.1:${server.address().port}`;
    const get = async (q) => (await fetch(`${B}/api/offers?${q}`)).json();
    const made = await store.createOffer({ locationId: ROUTE_LOC, contactId: "c-route", address: "1 Route St, Testville, WA 98000",
      status: "sent", sends: [{ ts: new Date().toISOString() }] });
    const PAGE = "lean=1&limit=2000&activity=1&next=1";
    const first = await get(PAGE);
    assert.equal(first.activity, true);
    assert.equal(first.next, true);
    assert.equal(first.offers.length, 1);

    // A draft queued is not an offer write: the minute stands.
    await store.createReplyDraft({ locationId: ROUTE_LOC, contactId: "c-route", status: "scheduled",
      sendAt: new Date(Date.now() + DAY).toISOString(), outbound: { kind: "offer_nudge", offerId: made.id } });
    assert.deepEqual(await get(PAGE), first, "answered from memory");
    // The work pane's one-person read and a page without both columns are never kept.
    assert.equal((await get("lean=1&limit=50&next=1&contact_id=c-route")).offers[0].nextFollowUp.kind, "queued");
    assert.equal((await get("lean=1&limit=2000&next=1")).offers[0].nextFollowUp.kind, "queued");

    // An offer written: the next load reads fresh.
    await store.updateOffer(made.id, { ...(await store.getOffer(made.id)), contactName: "Renamed" });
    const fresh = await get(PAGE);
    assert.equal(fresh.offers[0].nextFollowUp.kind, "queued");
    assert.notDeepEqual(fresh, first);
  } finally {
    server.close();
  }
});
