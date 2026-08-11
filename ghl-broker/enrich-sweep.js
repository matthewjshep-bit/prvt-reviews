// enrich-sweep.js — batch AI enrichment ("sweep"). Finds every contact with
// conversation activity inside a time window, runs the same transcript →
// Claude → fields pipeline as the per-contact ✨ Enrich button, and
// auto-applies the evidence-backed values (fields + tags + an audit note).
// Triggered on demand from the UI (Settings → AI conversation sweep) or by
// the nightly scheduler in broker.js. One job per location at a time, tracked
// in memory; the UI polls GET /enrich/sweep for progress. Restarts lose job
// history but never corrupt data — every write is the same idempotent
// per-contact apply the manual flow uses.

import {
  buildTranscript, runEnrichment, inferContactType, enrichFieldDefs,
  enrichTagVocab, ENRICH_TAG_GROUPS, mergeHistory, historyLine,
} from "./enrich.js";
import { fmtMoney } from "./shared/offer-calc.js";
import {
  searchConversations, getContact, updateContact, addContactTags,
  removeContactTags, createContactNote, findOrCreateCustomFieldByKey,
  customFieldIdKeyMap, contactCustomRecord,
} from "./ghl.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Epoch ms from a GHL timestamp that may be a number, numeric string, or ISO.
const msOf = (v) => {
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const PACE_MS = 150; // GHL burst cap is 100 req / 10s per location
const MAX_PAGES = 10; // collection scans at most 1000 conversations
const MAX_RESULTS_KEPT = 200;

/* ---------- job registry ---------- */

const jobs = new Map(); // locationId -> job (the current or most recent run)

export function getSweepJob(locationId) {
  return jobs.get(locationId) || null;
}

export function cancelSweepJob(locationId) {
  const job = jobs.get(locationId);
  if (!job || job.status !== "running") return false;
  job.cancelRequested = true;
  return true;
}

// JSON-safe snapshot for the polling route.
export function publicSweepJob(job) {
  if (!job) return null;
  const { cancelRequested, ...rest } = job;
  // Surface "stop requested, finishing the in-flight contact" to the UI.
  rest.stopping = Boolean(cancelRequested && job.status === "running");
  return rest;
}

/* ---------- starting a sweep ---------- */

// Kicks off a sweep in the background and returns the job immediately.
// Throws { http: 409 } if one is already running for the location.
export function startSweep({ client, locationId, saved, store, sinceIso, windowLabel, types, maxContacts, repliesOnly, trigger }) {
  const existing = jobs.get(locationId);
  if (existing?.status === "running") {
    throw Object.assign(new Error("a sweep is already running for this location"), { http: 409 });
  }
  const job = {
    id: `sweep-${Date.now().toString(36)}`,
    trigger: trigger || "manual",
    status: "running", // running | done | canceled | error
    phase: "collecting", // collecting | enriching
    windowLabel: windowLabel || "",
    sinceIso,
    types,
    maxContacts,
    repliesOnly: repliesOnly !== false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    done: 0,
    currentName: "",
    counts: { updated: 0, no_changes: 0, skipped: 0, errors: 0 },
    overCap: 0, // active contacts beyond maxContacts (not scanned)
    results: [],
    error: null,
    cancelRequested: false,
  };
  jobs.set(locationId, job);
  runSweep(job, { client, locationId, saved, store }).catch((e) => {
    job.status = "error";
    job.error = String(e?.message || e).slice(0, 300);
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

/* ---------- the sweep itself ---------- */

// Contacts with conversation activity since sinceMs, newest first:
// [{ contactId, lastMessageMs }]. Same desc-sort + startAfterDate cursor
// walk as the dashboard scans (1ms overlap so boundary ties aren't skipped).
async function collectActiveContacts(client, locationId, sinceMs) {
  const byContact = new Map();
  const seen = new Set();
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { conversations } = await searchConversations(client, locationId, {
      limit: 100,
      ...(cursor ? { startAfterDate: cursor } : {}),
    });
    if (!conversations.length) break;
    let hitWindowEnd = false;
    let fresh = 0;
    for (const c of conversations) {
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      fresh++;
      const ts = msOf(c.lastMessageDate);
      if (!Number.isFinite(ts)) continue;
      if (ts < sinceMs) { hitWindowEnd = true; continue; }
      if (!c.contactId) continue;
      const prev = byContact.get(c.contactId) || 0;
      if (ts > prev) byContact.set(c.contactId, ts);
    }
    if (hitWindowEnd || conversations.length < 100 || !fresh) break;
    cursor = msOf(conversations[conversations.length - 1].lastMessageDate);
    if (!Number.isFinite(cursor)) break;
    cursor += 1;
    await sleep(PACE_MS);
  }
  return [...byContact.entries()]
    .map(([contactId, lastMessageMs]) => ({ contactId, lastMessageMs }))
    .sort((a, b) => b.lastMessageMs - a.lastMessageMs);
}

// AI-proposed value -> validated write value, or null for "don't write".
// Mirrors the manual apply route's rules; enums are already schema-enforced
// at the AI layer, so this is belt-and-suspenders.
function normalizeProposed(def, v) {
  if (v === null || v === undefined) return null;
  const sv = String(v).trim();
  if (!sv || sv === "unknown") return null;
  if (def.dataType === "NUMERICAL") {
    const n = Number(sv.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (def.values && !def.multi) return def.values.includes(sv) ? sv : null;
  if (def.values && def.multi) {
    const parts = sv.split(",").map((p) => p.trim()).filter((p) => def.values.includes(p));
    return parts.length ? parts.join(", ") : null;
  }
  return sv.slice(0, 2000);
}

async function runSweep(job, { client, locationId, saved, store }) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  const extraInstructions = String(saved?.enrichExtraInstructions || "").trim();
  const sinceMs = new Date(job.sinceIso).getTime();

  const active = await collectActiveContacts(client, locationId, sinceMs);
  const targets = job.maxContacts > 0 ? active.slice(0, job.maxContacts) : active;
  job.overCap = active.length - targets.length;
  job.total = targets.length;
  job.phase = "enriching";

  // One field id per app key, created up front (not per contact) — the
  // lookup lists the location's fields, so doing it in the loop would be
  // O(contacts × fields) API calls.
  const neededDefs = new Map();
  for (const type of job.types) {
    for (const def of enrichFieldDefs(type)) neededDefs.set(def.key, def);
  }
  const fieldIds = new Map();
  for (const def of neededDefs.values()) {
    const id = await findOrCreateCustomFieldByKey(client, locationId, def.key, def.name, def.dataType);
    if (id) fieldIds.set(def.key, id);
    await sleep(PACE_MS);
  }
  const idKeyMap = await customFieldIdKeyMap(client, locationId);

  // App-side deal records, indexed once per sweep (listDeals scans the whole
  // location). Ground truth for the deal-history ledgers: the AI reconciles
  // against these instead of inventing properties.
  const dealsByContact = new Map();
  if (store) {
    try {
      const push = (cid, ev) => {
        if (!cid) return;
        const arr = dealsByContact.get(cid) || [];
        arr.push(ev);
        dealsByContact.set(cid, arr);
      };
      for (const o of await store.listDeals(locationId, { limit: 500 })) {
        const d = o.deal || {};
        push(o.contactId, {
          role: "agent", address: o.address,
          event: String(d.stage || "").replace(/_/g, " "),
          note: d.stage === "fell_through" ? d.fellThroughReason || "" : "",
          date: d.updatedAt || d.createdAt || "",
        });
        for (const inv of d.investors || []) {
          push(inv.contactId, {
            role: "investor", address: o.address,
            event: inv.status || "sent", note: "",
            date: inv.updatedAt || inv.addedAt || "",
          });
        }
      }
    } catch (e) { console.error("sweep: deal index failed:", e?.message); }
  }

  const pushResult = (row) => {
    if (row.status === "error") job.counts.errors++;
    else job.counts[row.status] = (job.counts[row.status] || 0) + 1;
    if (job.results.length < MAX_RESULTS_KEPT) job.results.push(row);
    job.done++;
  };

  for (const { contactId, lastMessageMs } of targets) {
    if (job.cancelRequested) {
      job.status = "canceled";
      job.finishedAt = new Date().toISOString();
      return;
    }
    let name = contactId;
    try {
      const contact = await getContact(client, contactId);
      if (!contact) { pushResult({ contactId, name, status: "skipped", reason: "contact not found" }); continue; }
      name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.contactName || contactId;
      job.currentName = name;
      const tags = contact.tags || [];

      // DND contacts are out of the pipeline — don't spend AI on them.
      if (contact.dnd === true) { pushResult({ contactId, name, status: "skipped", reason: "DND enabled" }); continue; }

      const type = inferContactType(tags);
      if (!type) { pushResult({ contactId, name, status: "skipped", reason: "no agent/investor tag (or both)" }); continue; }
      if (!job.types.includes(type)) { pushResult({ contactId, name, type, status: "skipped", reason: `${type}s excluded from this sweep` }); continue; }

      const currentFields = contactCustomRecord(contact, idKeyMap);

      // Already enriched since their newest message — nothing new to read.
      // The stamp is a full ISO timestamp (legacy date-only values parse as
      // UTC midnight and just re-run once before converging).
      const lastRunMs = new Date(currentFields.enrich_last_run || 0).getTime();
      if (Number.isFinite(lastRunMs) && lastRunMs > 0 && lastRunMs >= lastMessageMs) {
        pushResult({
          contactId, name, type, status: "skipped",
          reason: `already enriched ${String(currentFields.enrich_last_run).slice(0, 10)}, no messages since`,
        });
        continue;
      }

      let transcript;
      try {
        transcript = await buildTranscript(client, locationId, contactId);
      } catch (e) {
        if (e?.status === 401 || e?.status === 403) {
          throw Object.assign(
            new Error("GHL token is missing the conversations/message readonly scopes"),
            { fatal: true }
          );
        }
        throw e;
      }
      if (!transcript.stats.messages) { pushResult({ contactId, name, type, status: "skipped", reason: "no readable messages" }); continue; }

      // Replies-only: their newest message must fall inside the window —
      // outbound-only activity (our blasts, follow-ups) has nothing new to
      // learn and would burn an AI call for nothing.
      if (job.repliesOnly) {
        const inboundMs = transcript.lastInboundAt ? new Date(transcript.lastInboundAt).getTime() : 0;
        if (inboundMs < sinceMs) {
          pushResult({ contactId, name, type, status: "skipped", reason: "no reply in window (outbound only)" });
          continue;
        }
      }

      // Second cancel check: the top-of-loop one only catches between
      // contacts, and the AI call below is the long/expensive part.
      if (job.cancelRequested) {
        job.status = "canceled";
        job.finishedAt = new Date().toISOString();
        return;
      }

      // Authoritative history lines from the app's own records: deals this
      // contact is on, plus (agents) every offer we've sent them.
      const authLines = (dealsByContact.get(contactId) || [])
        .filter((e) => e.role === type)
        .map((e) => historyLine(e.date, e.address, e.event, e.note));
      if (type === "agent" && store) {
        try {
          for (const o of await store.listOffers(locationId, { contactId, limit: 50 })) {
            if (o.status === "draft") continue;
            authLines.push(historyLine(o.createdAt, o.address, `we offered ${fmtMoney(o.cashAmount)}`));
          }
        } catch (e) { console.error("sweep: offer history failed:", e?.message); }
      }

      const raw = await runEnrichment({
        contact, currentFields, currentTags: tags, transcript, type, extraInstructions,
        dealContext: authLines.length ? authLines.join("\n") : null,
        aiApiKey,
      });

      // Field writes: evidence-backed proposals that differ from the current
      // value, plus the two server stamps.
      const today = new Date().toISOString().slice(0, 10);
      const applied = []; // { key, name, value } — the meaningful changes
      const fieldWrites = [];
      for (const def of enrichFieldDefs(type)) {
        let value = null;
        // Full ISO stamp — the already-enriched skip compares it against the
        // contact's newest-message timestamp.
        if (def.key === "enrich_last_run") value = new Date().toISOString();
        else if (def.key === "last_convo_date") value = transcript.lastMessageAt ? transcript.lastMessageAt.slice(0, 10) : null;
        else if (def.append) {
          // History ledger: merge app-side truth + the AI's new events into
          // the existing value server-side — never a wholesale overwrite.
          const delta = normalizeProposed(def, raw.fields?.[def.key]?.value) || "";
          const merged = mergeHistory(currentFields[def.key], [...authLines, delta]);
          value = merged || null;
        }
        else value = normalizeProposed(def, raw.fields?.[def.key]?.value);
        if (value === null) continue;
        const current = String(currentFields[def.key] ?? "").trim();
        if (String(value) === current) continue;
        const id = fieldIds.get(def.key);
        if (!id) continue;
        fieldWrites.push({ id, value });
        if (!def.serverSet) applied.push({ key: def.key, name: def.name, value });
      }

      // Tag changes with the same mutual-exclusion expansion as the manual
      // preview: adding one of a group removes its currently-present siblings.
      const vocab = new Set(enrichTagVocab(type));
      const has = (t) => tags.includes(t);
      const tagsAdd = [...new Set((raw.tags?.add || []).filter((t) => vocab.has(t) && !has(t)))];
      const tagsRemove = new Set((raw.tags?.remove || []).filter((t) => vocab.has(t) && has(t)));
      for (const group of ENRICH_TAG_GROUPS[type] || []) {
        for (const t of tagsAdd) {
          if (!group.includes(t)) continue;
          for (const sib of group) if (sib !== t && has(sib)) tagsRemove.add(sib);
        }
      }

      if (fieldWrites.length) await updateContact(client, contactId, { customFields: fieldWrites });
      if (tagsAdd.length) await addContactTags(client, contactId, tagsAdd);
      if (tagsRemove.size) await removeContactTags(client, contactId, [...tagsRemove]);

      const changed = applied.length || tagsAdd.length || tagsRemove.size;
      if (changed) {
        const noteLines = [
          `AI SWEEP — ${today}${job.windowLabel ? ` (${job.windowLabel})` : ""}`,
          String(raw.summary || "").trim(),
          applied.length ? `Updated: ${applied.map((a) => `${a.name} = ${a.value}`).join("; ")}` : "",
          tagsAdd.length ? `Tags added: ${tagsAdd.join(", ")}` : "",
          tagsRemove.size ? `Tags removed: ${[...tagsRemove].join(", ")}` : "",
        ].filter(Boolean);
        try {
          await createContactNote(client, contactId, { body: noteLines.join("\n").slice(0, 4000) });
        } catch { /* audit note is best-effort */ }
      }

      pushResult({
        contactId, name, type,
        status: changed ? "updated" : "no_changes",
        confidence: raw.confidence || null,
        fields: applied,
        tagsAdded: tagsAdd,
        tagsRemoved: [...tagsRemove],
      });
      await sleep(PACE_MS);
    } catch (e) {
      // Failures that would repeat identically for every remaining contact
      // (missing GHL scope, bad AI key) abort the sweep instead of burning
      // API calls one contact at a time.
      if (e?.fatal) throw e;
      if (e?.status === 401 && String(e.message || "").toLowerCase().includes("api key")) throw e;
      pushResult({ contactId, name, status: "error", error: String(e?.message || e).slice(0, 200) });
    }
  }

  job.currentName = "";
  job.status = "done";
  job.finishedAt = new Date().toISOString();
}

/* ---------- nightly scheduler hook ---------- */

const NIGHTLY_WINDOW_MS = 26 * 3600 * 1000; // last-24h sweep with slack for drift
const NIGHTLY_MIN_GAP_MS = 20 * 3600 * 1000;

// Called on a timer by broker.js for each known location. Runs at most one
// nightly sweep per ~day per location; skips quietly when the toggle or the
// AI key is missing, or when any sweep ran recently.
export function maybeStartNightlySweep({ client, locationId, saved, store, utcHour }) {
  if (new Date().getUTCHours() !== utcHour) return false;
  if (!saved?.enrichSweepNightly) return false;
  if (!String(saved?.aiApiKey || "").trim()) return false;
  const last = jobs.get(locationId);
  if (last && (last.status === "running" || Date.now() - new Date(last.startedAt).getTime() < NIGHTLY_MIN_GAP_MS)) {
    return false;
  }
  startSweep({
    client, locationId, saved, store,
    sinceIso: new Date(Date.now() - NIGHTLY_WINDOW_MS).toISOString(),
    windowLabel: "nightly · last 26h",
    types: ["agent", "investor"],
    maxContacts: 0, // uncapped — the already-enriched skip keeps nightly cost flat
    repliesOnly: true,
    trigger: "nightly",
  });
  return true;
}
