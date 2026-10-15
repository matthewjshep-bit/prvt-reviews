// contact-email.js — an email address someone texted us reaches GHL, and a
// buyer can have deals by email.
//
// The rules (whose address it is, when it may replace one on file, what a
// buyer asking for email sounds like) are shared/contact-email.js. This is
// the I/O: GHL's duplicate check and contact write, the record, the
// Dispositions row, and the GHL tag that mirrors `deals_by`.
//
// Never throws. Nothing here sends anything. Logs carry the contact id only,
// never the address.

import { getContact, updateContact, findDuplicateContact, addContactTags, removeContactTags } from "./ghl.js";
import { ensureProfile, learnFacts, recordEvent } from "./contact-record.js";
import { investorProfileText } from "./investor-row.js";
import { emailSaveFor, validEmail, DEALS_BY_EMAIL_TAG } from "./shared/contact-email.js";

// A GHL error can echo the request URL, and the duplicate search carries the
// address in it: anything that looks like one is blanked before it's logged.
const redact = (s) => String(s || "").replace(/[^\s/?&=]+(@|%40)[^\s/?&=]+/gi, "[email]");
const log = (what, contactId, e) => console.error(`contact-email: ${what} contact=${contactId}:`, redact(e?.message || e).slice(0, 160));
const nowIso = () => new Date().toISOString();

/**
 * writeContactEmail({ client, store, locationId, contactId, party, email, previous, source, ref, how })
 *   → { ok, email, reason? }
 *
 * Put an address on the GHL contact, the record and the buyer's Dispositions
 * row. Refused when another GHL contact already has it: GHL's duplicate rule
 * would reject it or, worse, two people would end up one. A refusal leaves an
 * `email_offered` row for Today instead.
 */
export async function writeContactEmail({ client, store, locationId, contactId, party = null, email, previous = "", source = "conversation", ref = null, how = "set", now = Date.now() } = {}) {
  const e = validEmail(email);
  if (!client || !locationId || !contactId || !e) return { ok: false, email: e, reason: "no address" };
  const at = new Date(now).toISOString();
  try {
    const dup = await findDuplicateContact(client, locationId, { email: e });
    if (dup?.id && dup.id !== contactId) {
      await offerEmail({ store, locationId, contactId, party, email: e, current: previous, why: "another GHL contact has it", source, ref, at });
      return { ok: false, email: e, reason: "another GHL contact has it" };
    }
    await updateContact(client, contactId, { email: e });
  } catch (err) {
    log("GHL write failed", contactId, err);
    await offerEmail({ store, locationId, contactId, party, email: e, current: previous, why: "GHL didn't take it", source, ref, at });
    return { ok: false, email: e, reason: "GHL didn't take it" };
  }
  await ensureProfile({ store, locationId, contactId, party, email: e });
  await recordEvent({
    store, locationId, contactId, party, type: "email_saved", at, source, ref,
    dedupeKey: `email_saved:${contactId}:${e}:${at}`, data: { email: e, previous: validEmail(previous), how },
  });
  // The Dispositions book's copy: the next wave reads its email from here.
  try {
    const row = await store?.getInvestor?.(locationId, contactId);
    if (row) {
      const doc = { ...(row.doc || {}), email: e };
      await store.updateInvestorDoc(locationId, contactId, doc, investorProfileText(doc), { synced: false });
    }
  } catch (err) { log("book row", contactId, err); }
  return { ok: true, email: e };
}

async function offerEmail({ store, locationId, contactId, party, email, current = "", why, source, ref, at }) {
  await recordEvent({
    store, locationId, contactId, party, type: "email_offered", at, source, ref,
    // One row per address: texting it twice doesn't ask twice.
    dedupeKey: `email_offered:${contactId}:${email}`, data: { email, current: validEmail(current), why },
  });
}

/**
 * saveTextedEmail({ client, store, locationId, contactId, party, message, isCall, current, ref })
 *   → { action, email, ok?, reason? }
 *
 * An address in their text, against the one GHL has (`current`, or read from
 * GHL when not given). Set when GHL has none, replaced when they said it's
 * theirs, asked about on Today when it's unclear, left alone when it's
 * someone else's.
 */
export async function saveTextedEmail({ client, store, locationId, contactId, party = null, message = "", isCall = false, current, ref = null, now = Date.now() } = {}) {
  if (!client || !contactId || isCall || !String(message || "").includes("@")) return { action: "none", email: "" };
  let cur = current;
  if (cur === undefined) {
    try { cur = (await getContact(client, contactId))?.email || ""; }
    catch (e) { log("read contact", contactId, e); return { action: "none", email: "", reason: "couldn't read the contact" }; }
  }
  const plan = emailSaveFor({ message, current: cur, isCall });
  if (plan.action === "set" || plan.action === "replace") {
    const r = await writeContactEmail({ client, store, locationId, contactId, party, email: plan.email, previous: cur, source: "conversation", ref, how: plan.action, now });
    return { ...plan, ...r };
  }
  if (plan.action === "ask") {
    await offerEmail({ store, locationId, contactId, party, email: plan.email, current: cur, why: plan.why, source: "conversation", ref, at: new Date(now).toISOString() });
  }
  return plan;
}

/**
 * setDealsBy({ client, store, locationId, contactId, value, source, ref }) → { ok, value }
 *
 * "email": every deal goes to this buyer by email instead of a text
 * (dispo-autopilot.js blastChannel). "text": back to texts. On the record as
 * the `deals_by` fact, mirrored as the GHL tag dispo-deals-by-email.
 */
export async function setDealsBy({ client, store, locationId, contactId, value, source = "operator", ref = null } = {}) {
  const v = value === "email" ? "email" : value === "text" ? "text" : "";
  if (!v || !store || !locationId || !contactId) return { ok: false, value: v };
  await learnFacts({ store, locationId, contactId, party: "investor", facts: [{ key: "deals_by", value: v, source, at: nowIso(), ref }] });
  if (client) {
    try {
      if (v === "email") await addContactTags(client, contactId, [DEALS_BY_EMAIL_TAG]);
      else await removeContactTags(client, contactId, [DEALS_BY_EMAIL_TAG]);
      await recordEvent({ store, locationId, contactId, party: "investor", type: v === "email" ? "tag_added" : "tag_removed", source, ref, dedupeKey: null, data: { tag: DEALS_BY_EMAIL_TAG } });
    } catch (e) { log("deals tag", contactId, e); }
  }
  return { ok: true, value: v };
}
