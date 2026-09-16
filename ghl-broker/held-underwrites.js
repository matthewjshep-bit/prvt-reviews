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
import { triageHeldUnderwrite, retireNote } from "./shared/held-underwrites.js";
import { aiHoldReasons, isAiGenerated, effectiveStatus } from "./shared/offer-status.js";
import { auditDedupeKey } from "./shared/conversation-audit.js";
import { conversationConfig, startProactive as defaultStartProactive } from "./reply-agent.js";
import { recordEvent } from "./contact-record.js";
import { getContact, searchOpportunities, listPipelines, createContactNote, removeContactTags, smsUnsubscribed } from "./ghl.js";
import { UW_TAGS } from "./auto-underwrite.js";

const iso = (t) => new Date(t).toISOString();
const wait = (msec) => new Promise((r) => setTimeout(r, msec));

// Finding kinds, as the audit lists them (labels live in AUDIT_KINDS).
export const KIND_OF = { drop: "held_junk", retire: "held_over", rerun: "held_rerun", ask: "held_ask", yours: "held_yours", wait: null };
export const ACTION_OF = { drop: "drop_draft", retire: "retire_draft", rerun: "rerun_held", ask: "ask_take" };

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
  const may = !dryRun && config.enabled;
  const startProactive = typeof deps.startProactive === "function" ? deps.startProactive : defaultStartProactive;
  const botOffTags = (config.routing?.botOffTags || []).map((t) => String(t).toLowerCase());

  for (const [contactId, mine] of byContact) {
    const siblings = offers.filter((o) => o?.contactId === contactId);
    let events = [], drafts = [], contact = null, opportunities = [];
    if (contactId) {
      [events, drafts] = await Promise.all([
        store.listContactEvents(locationId, contactId, { limit: 300 }).catch(() => []),
        store.listReplyDrafts(locationId, { contactId, limit: 40 }).catch(() => []),
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
      const t = triageHeldUnderwrite({ offer: o, siblings, events, drafts, contact, opportunities, botOffTags, now });
      const kind = KIND_OF[t.action];
      if (t.action === "wait") { counts.waiting++; continue; }
      const f = {
        kind, severity: t.action === "yours" || t.action === "ask" || t.action === "rerun" ? "soon" : "fyi",
        contactId, contactName: o.contactName || "", party: "agent", address: o.address || "", offerId: o.id,
        why: t.reason, anchorAt: t.anchorAt, dueAt: iso(now), evidence: { held: t.held, needs: t.needs || [] },
        action: ACTION_OF[t.action] ? { type: ACTION_OF[t.action], ...(t.status ? { status: t.status } : {}), ...(t.needs ? { needs: t.needs } : {}) } : null,
      };
      f.id = auditDedupeKey(f);
      findings.push(f);
      if (t.action === "yours") { counts.yours++; continue; }
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
          await store.updateOffer(o.id, {
            ...full, status: t.status, statusAt: ts, statusNote: note,
            statusHistory: [...(full.statusHistory || []), { status: t.status, ts, note }],
            retired: { at: ts, by: "held-sweep", reason: t.reason }, updatedAt: ts,
          });
          await recordEvent({
            store, locationId, contactId, party: "agent", type: `offer_${t.status}`, at: ts, address: o.address || "", offerId: o.id,
            source: "sweep", dedupeKey: `held_retired:${o.id}`, data: { phrase: note, by: "held-sweep", reason: t.reason },
          }).catch(() => {});
          if (contactId) await createContactNote(client, contactId, { body: note }).catch(() => {});
          row.status = "retired"; counts.retired++; closed++;
        } else {
          // A text or a run: claimed first, keyed on the thing it answers (the
          // hold for an ask, their newest number for a re-run).
          const c = await recordEvent({
            store, locationId, contactId, party: "agent", type: "audit_action", at: iso(now), address: o.address || "", offerId: o.id,
            source: "sweep", dedupeKey: f.id, data: { kind, action: f.action.type, why: t.reason, needs: t.needs || [] },
          }).catch(() => ({ inserted: false }));
          if (!c.inserted) { row.status = "claimed"; continue; }
          if (t.action === "rerun") {
            if (typeof deps.startUnderwrite !== "function") { row.status = "skipped"; row.reason = "the underwriter is not wired"; continue; }
            const r = await deps.startUnderwrite({ contactId, message: "", address: o.address, askingPrice: t.askingPrice || 0, replaceOfferId: o.id });
            if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; }
            else { row.jobId = r?.job?.id || null; row.status = r?.queued ? "queued" : "started"; counts.reran++; }
          } else if (t.action === "ask") {
            const full = (await store.getOffer?.(o.id).catch(() => null)) || o;
            const r = await startProactive({
              client, locationId, saved, store, contactId, kind: "take_ask", offer: full,
              subject: { address: o.address, heldReason: t.heldReason, needs: t.needs || ["value", "work"] }, sendsEnabled, deps,
            });
            if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; } else { row.jobId = r?.job?.id || null; counts.asked++; }
          }
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
