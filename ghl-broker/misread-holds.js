// A text the machine started, held because the money reader saw a price in
// it that isn't there. The first texts of 2026-10-05 said "your listing at
// 1301 225th Pl SE" and were held as naming $1,301,000. The reader was fixed
// that morning (SHORT_STREET, shared/current-offer.js), but a held draft is
// never read again and the 7pm audit never releases a gate's hold, so the
// ones held before the fix sat on the Desk under Decide as Matt's call.
//
// Each tick reads those drafts again with the gate's own readers. When none
// of the numbers it was held for is still there, and the switches as they
// stand would send it by itself, it goes back on its clock, spread across the
// day as the sweep spreads them. The send-time checks still apply: you texted
// them, they unsubscribed, the bot is stopped on them, the house is gone.
import { moneyIn, conversationConfig, decideAutoSend } from "./reply-agent.js";
import { shorthandPrices } from "./shared/current-offer.js";
import { fmtMoney } from "./shared/offer-calc.js";
import { spreadAcrossDay, machineHours } from "./conversation-scheduler.js";

// evaluateReplyGates' words for a number in neither the record book nor
// their message. The contract-price/fee flag is a different sentence and is
// never released here.
const INVENTED_RX = /^the draft names (.+), which is not in the (?:offer|deal) book$/;
const HELD_FOR_A_NUMBER_RX = /^needs a person: the draft names .+, which is not in the (?:offer|deal) book$/;
// Older than this, a first text or a nudge is no longer news about the house.
export const MISREAD_MAX_AGE_HOURS = 72;

/**
 * misreadHold(draft, { config, sendsEnabled, now }) → { ok, reason, amounts }
 *
 * Whether a held draft was held only for a number the reader no longer sees
 * in it, and would send itself today. Pure. `config` is conversationConfig.
 */
export function misreadHold(d = {}, { config, sendsEnabled = false, now = Date.now(), maxAgeHours = MISREAD_MAX_AGE_HOURS } = {}) {
  const no = (reason) => ({ ok: false, reason, amounts: [] });
  if (d.status !== "draft") return no(`the draft is ${d.status || "gone"}`);
  if (!d.outbound?.kind || String(d.inbound || "").trim()) return no("a reply to their text, not one the machine started");
  if (!HELD_FOR_A_NUMBER_RX.test(String(d.autoSend?.reason || ""))) return no("not held for a number");
  const amounts = [];
  for (const f of d.flags || []) {
    const m = INVENTED_RX.exec(String(f));
    if (!m) return no("held for more than a number");
    amounts.push(...moneyIn(m[1]));
  }
  if (!amounts.length) return no("not held for a number");
  if (d.needsHuman) return no("it was flagged for a person");
  const made = Date.parse(d.createdAt || "");
  if (!Number.isFinite(made) || now - made > maxAgeHours * 3600000) return no(`drafted more than ${maxAgeHours}h ago`);
  // The gate's two readers. Shorthand ("at 650") is read against the number
  // itself, so a figure the reader still takes for a price is always found.
  const reply = String(d.reply || "");
  const read = new Set(moneyIn(reply));
  const still = amounts.filter((v) => read.has(v) || shorthandPrices(reply, v).includes(v));
  if (still.length) return no(`it still names ${still.map((v) => fmtMoney(v)).join(", ")}`);
  const auto = decideAutoSend({ gate: { ok: true, flags: [] }, party: d.party || "agent", intent: d.intent || d.outbound.kind, channel: d.channel || "sms", config, sendsEnabled });
  if (!auto.send) return no(auto.reason);
  return { ok: true, reason: "", amounts };
}

/**
 * releaseMisreadHolds({ store, locationId, saved, sendsEnabled, now, dryRun })
 *
 * Every held draft misreadHold passes goes back to "scheduled". A contact
 * with another open draft keeps that one; the misread waits. No names in the
 * answer or the log.
 */
export async function releaseMisreadHolds({ store, locationId, saved = {}, sendsEnabled = false, now = Date.now(), dryRun = false, random = Math.random }) {
  const config = conversationConfig(saved);
  const a = config.autoSend || {};
  const held = await store.listReplyDrafts(locationId, { status: "draft", limit: 200 }).catch(() => []);
  const rows = [];
  for (const d of held) {
    const v = misreadHold(d, { config, sendsEnabled, now });
    if (!v.ok) continue;
    const open = [];
    for (const status of ["draft", "scheduled"]) {
      open.push(...await store.listReplyDrafts(locationId, { contactId: d.contactId, status, limit: 5 }).catch(() => []));
    }
    if (open.some((o) => o.id !== d.id)) { rows.push({ draftId: d.id, released: false, reason: "another draft is open for them" }); continue; }
    const sendAt = spreadAcrossDay({ now, quietHours: machineHours(a), hours: a.nudgeSpreadHours ?? 8, weekends: a.weekends || "all", random });
    if (!dryRun) {
      const ts = new Date(now).toISOString();
      const said = v.amounts.map((n) => fmtMoney(n)).join(", ");
      await store.updateReplyDraft(d.id, {
        ...d, status: "scheduled", sendAt, scheduledAt: ts, heldAt: null, updatedAt: ts, autoSendable: true, gateClean: true,
        flags: [`back on its clock: ${said} was a misread, not a price in the text`],
        autoSend: { ...(d.autoSend || {}), decided: true, reason: `back on its clock — ${said} was a misread, not a price in the text` },
      });
    }
    rows.push({ draftId: d.id, intent: d.intent, released: true, sendAt });
  }
  return { ok: true, dryRun, released: rows.filter((r) => r.released).length, rows };
}
