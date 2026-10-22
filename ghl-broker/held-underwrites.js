// held-underwrites.js — the nightly pass over "Underwrites that need a look".
//
// The triage is shared/held-underwrites.js (pure). This reads what it needs
// per held draft — the contact's other offers, timeline, drafts, GHL tags and
// opportunity stage — and carries out the verdict:
//
//   drop    store.deleteOffer
//   retire  a status + reason on the row, an offer_* event, a GHL note
//   rerun   startUnderwrite with replaceOfferId (the retry button's own path;
//           agentNumbersRescue prices it on their figures)
//   ask     startProactive("take_ask") — one text asking for the missing piece,
//           released by the audit like any nudge, sent at the next open minute
//
// Everything that ends in a text or a run is claimed first (audit_action with
// the finding's key) so a second pass starts nothing twice. Runs inside the
// nightly audit (conversation-audit.js) and by hand from its Run button.
// Matt, 2026-09-16: "delete, clean up based on conversation and opp stage …
// if it's held because we can't get a number, fill in the gaps by asking the
// agent their take on ARV and repairs and underwrite using that."

import { store as defaultStore } from "./store.js";
import { triageHeldUnderwrite, retireNote, knownCitiesFrom, passReasonInWords } from "./shared/held-underwrites.js";
import { aiHoldReasons, isAiGenerated, effectiveStatus } from "./shared/offer-status.js";
import { auditDedupeKey } from "./shared/conversation-audit.js";
import { conversationConfig, startProactive as defaultStartProactive, stopMachineTextsForOffer } from "./reply-agent.js";
import { recordEvent } from "./contact-record.js";
import { getContact, searchOpportunities, listPipelines, createContactNote, removeContactTags, smsUnsubscribed } from "./ghl.js";
import { UW_TAGS, knownAddressesFor } from "./auto-underwrite.js";
import { waitingReason } from "./outbox-guard.js";
import { leadSourceOf } from "./shared/lead-source.js";
import { staleUnsent, staleUnsentPatch, STALE_UNSENT_BY } from "./shared/stale-unsent.js";
import { supersededIds } from "./shared/current-offer.js";

const iso = (t) => new Date(t).toISOString();
const wait = (msec) => new Promise((r) => setTimeout(r, msec));

// Finding kinds, as the audit lists them (labels live in AUDIT_KINDS).
export const KIND_OF = { drop: "held_junk", retire: "held_over", rerun: "held_rerun", ask: "held_ask", yours: "held_yours", call: "held_call", wait: "held_waiting" };
export const ACTION_OF = { drop: "drop_draft", retire: "retire_draft", rerun: "rerun_held", ask: "ask_take" };

// The finding a triage verdict becomes. Its id is the claim key, so the
// nightly sweep and the promise driver (promise-resolver.js) can never both
// ask the same agent about the same hold, or re-run on the same numbers twice.
export function heldFinding(o, t, now = Date.now()) {
  const kind = KIND_OF[t.action];
  const f = {
    kind, severity: ["yours", "call", "ask", "rerun"].includes(t.action) ? "soon" : "fyi",
    contactId: o.contactId || "", contactName: o.contactName || "", party: "agent", address: o.address || "", offerId: o.id,
    why: t.reason, anchorAt: t.anchorAt, dueAt: iso(now), evidence: { held: t.held, needs: t.needs || [] },
    ...(t.passAt ? { passAt: t.passAt } : {}),
    action: ACTION_OF[t.action] ? { type: ACTION_OF[t.action], ...(t.status ? { status: t.status } : {}), ...(t.needs ? { needs: t.needs } : {}) } : null,
  };
  f.id = auditDedupeKey(f);
  return f;
}

/**
 * carryOutHeldVerdict({ client, locationId, saved, store, sendsEnabled, deps, offer, triage, now })
 *   → { status: "started"|"queued"|"claimed"|"skipped", reason, jobId }
 *
 * The two verdicts that text or spend: `ask` (one take_ask for the missing
 * piece) and `rerun` (the underwriter again, on their numbers). Claimed first,
 * keyed on the thing it answers: the hold for an ask, their newest number for
 * a re-run.
 */
export async function carryOutHeldVerdict({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, offer: o, triage: t, now = Date.now() }) {
  if (t?.action !== "rerun" && t?.action !== "ask") return { status: "skipped", reason: `nothing to carry out for "${t?.action}"`, jobId: null };
  const f = heldFinding(o, t, now);
  const contactId = o.contactId || "";
  // The ask is a text the machine starts: it waits, unclaimed, while their
  // text or your own draft is in the outbox.
  if (t.action === "ask") {
    const waiting = await waitingReason({ store, locationId, contactId });
    if (waiting) return { status: "skipped", reason: waiting, jobId: null };
  }
  const c = await recordEvent({
    store, locationId, contactId, party: "agent", type: "audit_action", at: iso(now), address: o.address || "", offerId: o.id,
    source: "sweep", dedupeKey: f.id, data: { kind: f.kind, action: f.action.type, why: t.reason, needs: t.needs || [] },
  }).catch(() => ({ inserted: false }));
  if (!c.inserted) return { status: "claimed", reason: "", jobId: null };
  if (t.action === "rerun") {
    if (typeof deps.startUnderwrite !== "function") return { status: "skipped", reason: "the underwriter is not wired", jobId: null };
    // `t.address`: the full address the triage found for a street the map missed.
    const r = await deps.startUnderwrite({ contactId, message: "", address: t.address || o.address, askingPrice: t.askingPrice || 0, replaceOfferId: o.id });
    if (r?.skipped) return { status: "skipped", reason: r.skipped, jobId: null };
    return { status: r?.queued ? "queued" : "started", reason: "", jobId: r?.job?.id || null };
  }
  const start = typeof deps.startProactive === "function" ? deps.startProactive : defaultStartProactive;
  const full = (await store.getOffer?.(o.id).catch(() => null)) || o;
  // The ask commits to nothing, so it releases itself under the gates
  // whoever starts it (2026-10-20: the promise driver's sat on Today as "not
  // on the agent auto-send list"). A caller that says false is heard.
  const r = await start({
    client, locationId, saved, store, contactId, kind: "take_ask", offer: full,
    subject: { address: o.address, heldReason: t.heldReason, needs: t.needs || ["value", "work"] }, sendsEnabled,
    deps: { ...deps, releaseHeld: deps.releaseHeld ?? true, ...(deps.releaseHeld == null ? { releaseReason: "the ask for their numbers: commits to nothing" } : {}) },
  });
  if (r?.skipped) return { status: "skipped", reason: r.skipped, jobId: null };
  return { status: "started", reason: "", jobId: r?.job?.id || null };
}

/**
 * retireStaleUnsent({ client, locationId, saved, store, offers, now, dryRun })
 *   → { retired, findings, acted }
 *
 * A priced offer whose number never went out, `retireUnsentDays` overdue
 * (shared/stale-unsent.js, 2026-10-16): retired as we_passed, "never sent:
 * closed after N days", the held sweep's own `retired` shape with by
 * "stale-unsent". Nothing is texted and nothing goes to GHL; a machine text
 * still queued about it is dismissed, as the status menu's "we passed" does.
 * The agent is the agent check-in's from here.
 */
export async function retireStaleUnsent({ client = null, locationId, saved = {}, store = defaultStore, offers = null, now = Date.now(), dryRun = false }) {
  const config = conversationConfig(saved);
  const days = config.parties?.agent?.followUp?.retireUnsentDays ?? 0;
  const out = { retired: 0, findings: [], acted: [] };
  if (!(days > 0)) return out;
  const book = offers || await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []);
  // Only a house's current row (shared/current-offer.js): an older one the
  // house moved past is no row anybody reads.
  const replaced = supersededIds(book);
  const floatAfterHours = config.driver?.timers?.floatAfterHours || 4;
  const rows = book.filter((o) => o?.id && o.status !== "draft" && effectiveStatus(o) === "new" && !o.deal && !replaced.has(o.id));
  for (const lean of rows) {
    const full = (await store.getOffer?.(lean.id).catch(() => null)) || lean;
    // Cheap first: the row alone says "not yet" for most.
    const first = staleUnsent({ offer: full, days, floatAfterHours, now });
    if (!first.retire) continue;
    const contactId = full.contactId || "";
    const [drafts, events] = contactId ? await Promise.all([
      store.listReplyDrafts(locationId, { contactId, limit: 40 }).catch(() => []),
      store.listContactEvents(locationId, contactId, { limit: 300 }).catch(() => []),
    ]) : [[], []];
    const v = staleUnsent({ offer: full, drafts, events, days, floatAfterHours, now });
    if (!v.retire) continue;
    const f = { kind: "stale_unsent", severity: "fyi", contactId, contactName: full.contactName || "", party: "agent", address: full.address || "", offerId: full.id,
      why: v.why, anchorAt: full.createdAt || null, dueAt: new Date(now).toISOString(), evidence: { overdueDays: v.overdueDays }, action: null };
    f.id = auditDedupeKey(f);
    out.findings.push(f);
    if (dryRun) continue;
    const row = { contactId, contactName: f.contactName, address: f.address, kind: "stale_unsent", action: "close_unsent", status: "closed", reason: v.why, offerId: full.id };
    try {
      await store.updateOffer(full.id, staleUnsentPatch(full, { why: v.why, now }));
      await recordEvent({
        store, locationId, contactId, party: "agent", type: "offer_we_passed", at: new Date(now).toISOString(), address: full.address || "", offerId: full.id,
        source: "sweep", dedupeKey: `stale_unsent:${full.id}`, data: { phrase: v.why, by: STALE_UNSENT_BY },
      }).catch(() => {});
      await stopMachineTextsForOffer({ client, store, locationId, offer: full, why: `${String(full.address || "that house").split(",")[0]}: our number never went out — closed`, now }).catch(() => []);
      out.retired++;
    } catch (e) {
      row.status = "error"; row.reason = String(e?.message || e).slice(0, 160);
    }
    out.acted.push(row);
  }
  return out;
}

/**
 * sweepHeldUnderwrites({ client, locationId, saved, store, sendsEnabled, deps, now, dryRun, pace })
 *   → { findings, acted, counts, reason }
 *
 * `deps.startUnderwrite` and `deps.startProactive` are the offers router's
 * conversation deps; `deps.releaseHeld` is what lets the ask send itself.
 */
export async function sweepHeldUnderwrites({
  client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now(), dryRun = false, pace = 100,
}) {
  const config = conversationConfig(saved);
  const findings = [];
  const acted = [];
  const counts = { held: 0, dropped: 0, retired: 0, reran: 0, asked: 0, waiting: 0, yours: 0 };
  if (config.nightlyAudit?.heldSweep === false) return { findings, acted, counts, reason: "the held-underwrite sweep is switched off" };

  const offers = await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []);
  const may = !dryRun && config.enabled;
  // A number we priced and never sent, ten days on: closed out quietly in the
  // same pass (retireStaleUnsent). Reported on a dry run, done on a real one.
  // Its findings (kind stale_unsent) are the count: the audit's byKind reads them.
  const stale = await retireStaleUnsent({ client, locationId, saved, store, offers, now, dryRun: !may }).catch(() => ({ retired: 0, findings: [], acted: [] }));
  findings.push(...stale.findings);
  acted.push(...stale.acted);
  const held = offers.filter((o) => o && effectiveStatus(o) === "draft" && isAiGenerated(o) && aiHoldReasons(o).length > 0);
  counts.held = held.length;
  if (!held.length) return { findings, acted, counts, reason: "" };

  // Stage names once; GHL's opportunity rows carry only the stage id.
  let stageName = new Map();
  try {
    for (const p of await listPipelines(client, locationId)) for (const s of p.stages || []) stageName.set(s.id, s.name);
  } catch { stageName = new Map(); }

  const byContact = new Map();
  for (const o of held) {
    const c = o.contactId || "";
    if (!byContact.has(c)) byContact.set(c, []);
    byContact.get(c).push(o);
  }
  const startProactive = typeof deps.startProactive === "function" ? deps.startProactive : defaultStartProactive;
  const botOffTags = (config.routing?.botOffTags || []).map((t) => String(t).toLowerCase());
  // The towns we buy in: our map, and anywhere we've put a number on a house.
  const knownCities = knownCitiesFrom(offers);

  for (const [contactId, mine] of byContact) {
    const siblings = offers.filter((o) => o?.contactId === contactId);
    let events = [], drafts = [], contact = null, opportunities = [], hooks = [], knownAddresses = [];
    if (contactId) {
      [events, drafts, hooks, knownAddresses] = await Promise.all([
        store.listContactEvents(locationId, contactId, { limit: 300 }).catch(() => []),
        store.listReplyDrafts(locationId, { contactId, limit: 40 }).catch(() => []),
        typeof store.listOutreachHooks === "function" ? store.listOutreachHooks(locationId, { contactId }).catch(() => []) : [],
        knownAddressesFor({ store, locationId, contactId }).catch(() => []),
      ]);
      try {
        const c = await getContact(client, contactId);
        contact = { tags: c?.tags || [], dnd: smsUnsubscribed(c) };
      } catch { contact = null; }
      try {
        opportunities = (await searchOpportunities(client, locationId, { contactId })).map((o) => ({ ...o, stageName: stageName.get(o.stageId) || "" }));
      } catch { opportunities = []; }
    }

    let closed = 0;
    for (const o of mine.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))) {
      const brought = o.autoUnderwrite?.leadSource === "agent_brought" || leadSourceOf({ offer: o, hooks, events }).source === "agent_brought";
      const t = triageHeldUnderwrite({ offer: o, siblings, events, drafts, contact, opportunities, botOffTags, now, knownCities, brought, knownAddresses });
      const kind = KIND_OF[t.action];
      // A wait with a date (asked, passes in a week) is reported, so the
      // Desk can say when; any other wait is nothing to say.
      if (t.action === "wait") { counts.waiting++; if (t.passAt) findings.push(heldFinding(o, t, now)); continue; }
      const f = heldFinding(o, t, now);
      findings.push(f);
      if (t.action === "yours" || t.action === "call") { counts.yours++; continue; }
      if (!may) continue;

      const row = { contactId, contactName: f.contactName, address: f.address, kind, action: f.action.type, status: "started", reason: t.reason, jobId: null, offerId: o.id };
      acted.push(row);
      try {
        if (t.action === "drop") {
          await store.deleteOffer(o.id);
          row.status = "dropped"; counts.dropped++; closed++;
        } else if (t.action === "retire") {
          const full = (await store.getOffer?.(o.id).catch(() => null)) || o;
          if (effectiveStatus(full) !== "draft") { row.status = "skipped"; row.reason = `the row is ${effectiveStatus(full)} now`; continue; }
          const ts = iso(now);
          const note = retireNote(o, t);
          // A quiet close on a house nothing went out on (2026-10-22): the
          // agent hears it once, through the pass note (pass-note.js sends a
          // "due" note in machine hours), with the reason the pill shows.
          const noteIt = Boolean(t.passNoteDue && contactId && !(full.sends || []).length && !full.floatSentAt);
          await store.updateOffer(o.id, {
            ...full, status: t.status, statusAt: ts, statusNote: note,
            statusHistory: [...(full.statusHistory || []), { status: t.status, ts, note }],
            retired: { at: ts, by: "held-sweep", reason: t.reason }, updatedAt: ts,
            ...(noteIt ? { passReason: { code: t.passNoteDue, at: ts, by: "held-sweep" }, passNote: { status: "due", markedAt: ts } } : {}),
          });
          await recordEvent({
            store, locationId, contactId, party: "agent", type: `offer_${t.status}`, at: ts, address: o.address || "", offerId: o.id,
            source: "sweep", dedupeKey: `held_retired:${o.id}`, data: { phrase: note, by: "held-sweep", reason: t.reason },
          }).catch(() => {});
          if (contactId) await createContactNote(client, contactId, { body: note }).catch(() => {});
          row.status = "retired"; counts.retired++; closed++;
          if (noteIt) { row.reason = `${t.reason} — the pass note tells them`; counts.passNotes = (counts.passNotes || 0) + 1; }
          // Not our kind of house, or not our area: they hear it from us,
          // once, so a "we'll come back with a number" isn't left hanging.
          // A house we promised a number on, or whose last word from them
          // we never answered (2026-10-14): they hear we're out too. Sent
          // like the others only with heldTriage.passOnRetire on; off, the
          // draft waits for you.
          const ownSwitch = t.passNote === "promised" && !config.heldTriage?.passOnRetire;
          if (t.passNote && contactId) {
            const r = await startProactive({ client, locationId, saved, store, contactId, kind: "kind_pass", offer: { ...full, status: t.status },
              subject: { address: o.address, why: t.passNote, heldReason: t.reason, ...(t.promised ? { owed: t.promised.what, promisedAt: t.promised.at, reason: passReasonInWords(t) } : {}) },
              sendsEnabled, deps: { ...deps, startProactive, ...(ownSwitch ? { releaseHeld: false, releaseByDay: false,
                holdForAPerson: "we owed them a number on this house; the pass waits for you while heldTriage.passOnRetire is off" } : {}) } }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 120) }));
            row.reason = `${t.reason}${r?.skipped ? ` — no note: ${r.skipped}` : ownSwitch ? " — a pass text is drafted for you" : " — told them"}`;
          }
        } else {
          const r = await carryOutHeldVerdict({ client, locationId, saved, store, sendsEnabled, deps: { ...deps, startProactive }, offer: o, triage: t, now });
          row.status = r.status; row.jobId = r.jobId;
          if (r.reason) row.reason = r.reason;
          if (r.status === "claimed") continue;
          if (t.action === "rerun" && (r.status === "started" || r.status === "queued")) counts.reran++;
          if (t.action === "ask" && r.status === "started") counts.asked++;
        }
      } catch (e) {
        row.status = "error"; row.reason = String(e?.message || e).slice(0, 160);
      }
      if (pace > 0) await wait(pace);
    }
    // The review tag is per contact; once nothing of theirs is held any
    // more it comes off, so GHL stops saying "needs review" about a house
    // that's gone. Best-effort.
    if (closed && contactId && may && closed >= mine.length) {
      await removeContactTags(client, contactId, [UW_TAGS.review]).catch(() => {});
    }
  }
  return { findings, acted, counts, reason: may ? "" : dryRun ? "dry run" : "Conversation AI is switched off — reported, nothing started" };
}
