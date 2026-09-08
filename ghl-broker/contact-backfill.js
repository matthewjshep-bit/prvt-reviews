// contact-backfill.js — fill the record from what already exists.
//
// The record starts empty on the day it ships, but nothing about a person is
// new: years of offers, deals, passes, drafts and dataroom views are in the
// app's tables, and years of ledger lines and buy-box fields are on the GHL
// contact. This walks both and files them — once, or as many times as you
// like, because every event carries a dedupe key and every fact dedupes on
// its value. A second run reports inserted: 0.
//
// Two passes. The APP pass costs no GHL calls: offers → offerEvents, drafts →
// draftEvents + draftFacts, invites → inviteEvents. The GHL pass reads each
// contact once (150 ms apart, retrying a 429) and hands it to
// reconcileFromGhl, which learns the fields the record lacks and turns the
// ledger into events. The id→key map is built once for the whole run.
//
// Operator-triggered from Settings, never on boot: it reads every contact.

import { getContact, customFieldIdKeyMapForDefs } from "./ghl.js";
import { recordEvents, learnFacts, reconcileFromGhl, ensureProfile, RECORD_FIELD_DEFS, contactName } from "./contact-record.js";
import { offerEvents, draftEvents, draftFacts, inviteEvents } from "./shared/contact-record.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE_MS = 150;

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) { if (e.status !== 429 || attempt >= 2) throw e; await sleep(2000 * (attempt + 1)); }
  }
}

/* ---------- job registry (one per location, same shape as the sweep) ---------- */

const jobs = new Map();
export const getBackfillJob = (locationId) => jobs.get(locationId) || null;
export function publicBackfillJob(job) {
  if (!job) return null;
  const { cancelRequested, ...rest } = job;
  rest.stopping = Boolean(cancelRequested && job.status === "running");
  return rest;
}
export function cancelBackfill(locationId) {
  const job = jobs.get(locationId);
  if (!job || job.status !== "running") return false;
  job.cancelRequested = true;
  return true;
}

export function startContactBackfill({ client, locationId, store, sources = ["app", "ghl"], maxContacts = 5000 }) {
  const existing = jobs.get(locationId);
  if (existing?.status === "running") throw Object.assign(new Error("a backfill is already running for this location"), { http: 409 });
  const job = {
    id: `backfill-${Date.now().toString(36)}`,
    status: "running", phase: "collecting",
    sources, maxContacts,
    startedAt: new Date().toISOString(), finishedAt: null,
    total: 0, done: 0, currentName: "",
    counts: { contacts: 0, events: 0, skipped: 0, facts: 0, errors: 0 },
    errors: [], error: null, cancelRequested: false,
  };
  jobs.set(locationId, job);
  runContactBackfill(job, { client, locationId, store }).catch((e) => {
    job.status = "error";
    job.error = String(e?.message || e).slice(0, 300);
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

/**
 * runContactBackfill(job, { client, locationId, store })
 *
 * Exported for the test; startContactBackfill is the door.
 */
export async function runContactBackfill(job, { client, locationId, store }) {
  const useApp = job.sources.includes("app");
  const useGhl = job.sources.includes("ghl") && client;
  const bump = (r) => { job.counts.events += r.inserted || 0; job.counts.skipped += r.skipped || 0; };
  const fail = (who, e) => { job.counts.errors++; if (job.errors.length < 50) job.errors.push(`${who}: ${String(e?.message || e).slice(0, 160)}`); };

  // The universe: everyone the app has ever touched, with the party we know
  // them by. An agent is whoever an offer went to; a buyer is whoever sits on
  // a deal, in the investor book, or was sent a dataroom link.
  job.phase = "collecting";
  const people = new Map(); // contactId -> { party, name }
  const know = (contactId, party, name = "") => {
    if (!contactId) return;
    const cur = people.get(contactId) || { party: null, name: "" };
    people.set(contactId, { party: cur.party || party, name: cur.name || name });
  };
  const offers = await store.listOffers(locationId, { limit: 20000 });
  for (const o of offers) {
    know(o.contactId, "agent", o.contactName);
    for (const i of o.deal?.investors || []) know(i.contactId, "investor", i.name);
    for (const f of o.deal?.feedback || []) know(f.contactId, "investor", f.name);
  }
  let investors = [];
  try { investors = await store.listInvestors(locationId, { limit: 5000 }); } catch { /* no book yet */ }
  for (const i of investors) know(i.contactId, "investor", i.name);
  let drafts = [];
  try { drafts = await store.listReplyDrafts(locationId, { limit: 5000 }); } catch { /* none */ }
  for (const d of drafts) know(d.contactId, d.party === "investor" || d.party === "agent" ? d.party : null, d.contactName);
  const rooms = await store.listDatarooms(locationId, { limit: 1000 }).catch(() => []);
  const invites = [];
  for (const room of rooms) {
    const list = await store.listDataroomInvites(room.id).catch(() => []);
    for (const inv of list) { invites.push({ ...inv, address: room.address || room.snapshot?.property?.address || "", offerId: inv.offerId || room.offerId || null }); know(inv.contactId, "investor", inv.name); }
  }
  const ids = [...people.keys()].slice(0, job.maxContacts);
  job.total = ids.length;

  /* --- the app pass: no GHL calls --- */
  if (useApp) {
    job.phase = "app";
    const perContact = new Map();
    const add = (ev) => { if (!ev?.contactId) return; (perContact.get(ev.contactId) || perContact.set(ev.contactId, []).get(ev.contactId)).push(ev); };
    for (const o of offers) for (const ev of offerEvents(o)) add(ev);
    for (const inv of invites) for (const ev of inviteEvents(inv, { address: inv.address })) add(ev);
    const factsFor = new Map();
    for (const d of drafts) {
      for (const ev of draftEvents(d)) add(ev);
      const f = draftFacts(d);
      if (f.length) factsFor.set(d.contactId, [...(factsFor.get(d.contactId) || []), ...f]);
    }
    for (const contactId of ids) {
      if (job.cancelRequested) break;
      const p = people.get(contactId);
      try {
        await ensureProfile({ store, locationId, contactId, party: p.party, name: p.name || null });
        const evs = perContact.get(contactId) || [];
        if (evs.length) bump(await recordEvents({ store, locationId, contactId, party: p.party, events: evs }));
        const facts = factsFor.get(contactId) || [];
        if (facts.length) job.counts.facts += (await learnFacts({ store, locationId, contactId, party: p.party, facts })).added.length;
      } catch (e) { fail(contactId, e); }
    }
  }

  /* --- the GHL pass: one read per contact --- */
  if (useGhl && !job.cancelRequested) {
    job.phase = "ghl";
    const idKeyMap = await customFieldIdKeyMapForDefs(client, locationId, RECORD_FIELD_DEFS);
    job.done = 0;
    for (const contactId of ids) {
      if (job.cancelRequested) break;
      const p = people.get(contactId);
      job.currentName = p.name || contactId;
      try {
        const contact = await withRetry(() => getContact(client, contactId));
        if (contact) {
          const r = await reconcileFromGhl({ store, locationId, contactId, party: p.party, contact, idKeyMap });
          job.counts.events += r.events;
          job.counts.facts += r.facts;
          if (!p.name && contactName(contact)) people.set(contactId, { ...p, name: contactName(contact) });
        }
      } catch (e) {
        // A contact deleted in GHL since we last saw them is not an error of
        // ours; the app-side record stands on its own.
        if (e?.status !== 404) fail(p.name || contactId, e);
      }
      job.done++;
      job.counts.contacts = job.done;
      await sleep(PACE_MS);
    }
  } else {
    job.done = ids.length;
    job.counts.contacts = ids.length;
  }

  job.status = job.cancelRequested ? "canceled" : "done";
  job.currentName = "";
  job.finishedAt = new Date().toISOString();
  return job;
}
