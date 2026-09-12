// conversation-actions.js — what an intent triggers, in GHL or here.
//
// The operator wires "when an investor says they're interested, tag them and
// drop them into my follow-up workflow" on the Conversation AI page. This
// runs it. Two modes per rule: "auto" fires as soon as the intent is read
// with high confidence; "ask" shows the action on the draft row and a person
// applies it. A dataroom invite is ask-only whatever the row says.
//
// Every executor records its outcome on the action and never throws: a tag
// that fails to apply must not lose the draft, and the row shows what did and
// didn't happen.

import { ASK_ONLY_ACTIONS, substituteTokens } from "./shared/conversation-ai.js";
import {
  addContactTags, removeContactTags, addContactToWorkflow, removeContactFromWorkflow, findOrCreateCustomFieldByKey, updateContact,
} from "./ghl.js";
import { fmtMoney } from "./shared/offer-calc.js";
import { recordEvent, learnFacts } from "./contact-record.js";
import { FACT_KEYS } from "./shared/contact-record.js";

let seq = 0;
const newActionId = () => `a-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * planActions({ party, intent, confidence, playbook }) → { auto, suggested }
 *
 * Pure. Each returned action is { id, type, mode, status: "pending", ...params }.
 * A rule in auto mode still waits for a person when the model was not sure:
 * a wrongly-tagged contact starts a GHL workflow that texts people.
 */
const RANK = { low: 0, medium: 1, high: 2 };

export function planActions({ party, intent, confidence = "low", playbook = {}, minConfidence = "high" }) {
  const rule = playbook?.intentRules?.[intent];
  if (!rule || !Array.isArray(rule.actions) || !rule.actions.length) return { auto: [], suggested: [] };
  const auto = [];
  const suggested = [];
  // The same bar the reply uses to send itself: if the page says a medium
  // read may go, the tier move and the underwrite go with it. A reply that
  // sends while its actions sit as suggestions is the worst of both.
  const sure = (RANK[confidence] ?? 0) >= (RANK[minConfidence] ?? 2);
  for (const a of rule.actions) {
    const askOnly = ASK_ONLY_ACTIONS.has(a.type);
    // The rule's mode is a ceiling: an action can ask inside an auto rule
    // (send_offer ships that way) but can never run inside an ask rule.
    const mode = askOnly || a.mode === "ask" ? "ask" : rule.mode === "auto" ? "auto" : "ask";
    const action = { ...a, id: newActionId(), mode, status: "pending", party };
    if (mode === "auto" && sure) auto.push(action);
    else suggested.push(action);
  }
  return { auto, suggested };
}

// A tag or a field an intent rule sets is on the timeline too, with the
// draft that caused it as the source. Best-effort, after the GHL write.
const tagEvents = ({ store, locationId, contactId, draft, type, tags }) =>
  Promise.all((tags || []).map((tag) => recordEvent({
    store, locationId, contactId, party: draft?.party || null, type, source: "conversation", ref: draft?.id || null, data: { tag },
  })));

const EXECUTORS = {
  async add_tags({ client, contactId, action, store, locationId, draft, deps }) {
    await addContactTags(client, contactId, action.tags);
    await tagEvents({ store, locationId, contactId, draft, type: "tag_added", tags: action.tags });
    // A tier moved: the GHL pipeline mirror hears about it now, not at the
    // next quarter hour. Best effort.
    if (typeof deps?.onTagsChanged === "function") await deps.onTagsChanged({ contactId, tags: action.tags, party: draft?.party || null }).catch(() => {});
    return `tagged ${action.tags.join(", ")}`;
  },
  async remove_tags({ client, contactId, action, store, locationId, draft, deps }) {
    await removeContactTags(client, contactId, action.tags);
    await tagEvents({ store, locationId, contactId, draft, type: "tag_removed", tags: action.tags });
    if (typeof deps?.onTagsChanged === "function") await deps.onTagsChanged({ contactId, tags: action.tags, party: draft?.party || null }).catch(() => {});
    return `removed ${action.tags.join(", ")}`;
  },
  async set_field({ client, locationId, contactId, action, draft, store }) {
    const value = substituteTokens(action.value, draft).trim();
    // A template whose tokens all came up empty ({{propertyAddress}} on a
    // message that named no property) must not blank a field that had a
    // value — the Subject Property field aims the underwriter.
    if (!value && /\{\{/.test(action.value || "")) return `${action.key}: nothing to write`;
    const id = await findOrCreateCustomFieldByKey(client, locationId, action.key, action.key, "TEXT");
    if (!id) throw new Error(`could not find or create the field ${action.key}`);
    await updateContact(client, contactId, { customFields: [{ id, value }] });
    if (FACT_KEYS[action.key]) {
      await learnFacts({ store, locationId, contactId, party: draft?.party || null,
        facts: [{ key: action.key, value, source: "conversation", ref: draft?.id || null }] });
    }
    return `${action.key} = ${value.slice(0, 80)}`;
  },
  async add_to_workflow({ client, contactId, action }) {
    await addContactToWorkflow(client, contactId, action.workflowId);
    return `added to ${action.workflowName || action.workflowId}`;
  },
  // Leaving a workflow they were never in is a 4xx from GHL and not a
  // failure of ours — a tier move must not read as broken because the drip
  // had already finished.
  async remove_from_workflow({ client, contactId, action }) {
    try {
      await removeContactFromWorkflow(client, contactId, action.workflowId);
      return `removed from ${action.workflowName || action.workflowId}`;
    } catch (e) {
      if (e?.status && e.status >= 400 && e.status < 500) return `not in ${action.workflowName || action.workflowId}`;
      throw e;
    }
  },
  async mark_offer_countered({ deps, contactId, draft }) {
    if (typeof deps?.setOfferStatus !== "function") throw new Error("offer status is not wired on this broker");
    const note = draft?.counterAmount ? `countered at ${fmtMoney(draft.counterAmount)}` : String(draft?.summary || "").slice(0, 200);
    // The number the model read goes through as a NUMBER. It used to survive
    // only inside that sentence, which meant "what is the spread between our
    // offers and their counters" could not be answered without regexing notes.
    const r = await deps.setOfferStatus({
      contactId, addressHint: draft?.propertyAddress || "", status: "countered", note,
      amount: draft?.counterAmount || 0,
    });
    if (!r?.ok) return r?.reason || "no open offer to mark";
    return r.unchanged ? `offer on ${r.address} was already countered` : `offer on ${r.address} marked countered`;
  },
  async mark_offer_passed({ deps, contactId, draft }) {
    if (typeof deps?.setOfferStatus !== "function") throw new Error("offer status is not wired on this broker");
    const r = await deps.setOfferStatus({ contactId, addressHint: draft?.propertyAddress || "", status: "passed", note: String(draft?.summary || "").slice(0, 200) });
    if (!r?.ok) return r?.reason || "no open offer to mark";
    return r.unchanged ? `offer on ${r.address} was already passed` : `offer on ${r.address} marked passed`;
  },
  async mark_offer_realm_yes({ deps, contactId, draft }) {
    if (typeof deps?.setOfferRealm !== "function") throw new Error("offer realm is not wired on this broker");
    const r = await deps.setOfferRealm({ contactId, addressHint: draft?.propertyAddress || "", answer: "yes", note: String(draft?.summary || "").slice(0, 200) });
    if (!r?.ok) return r?.reason || "no open offer to note";
    return `${r.address}: in the realm — send the formal offer`;
  },
  // The first no on a live offer: remembered on the offer, so the second
  // one closes it. Injected by the reply agent, never wired on a rule.
  async note_first_decline({ deps, draft, action }) {
    if (typeof deps?.noteFirstDecline !== "function") throw new Error("first-decline notes are not wired on this broker");
    const r = await deps.noteFirstDecline({ offerId: action?.offerId, draftId: draft?.id || null, note: String(draft?.summary || "").slice(0, 200) });
    if (!r?.ok) return r?.reason || "no offer to note";
    return `first no on ${r.address} — asked for their number; a second no closes it`;
  },
  // A pass is only half the value; the reason is the other half. It goes on
  // the deal (so the next blast is priced or aimed differently) and on the
  // buyer (so we stop sending them the same thing).
  async mark_investor_passed({ deps, contactId, draft }) {
    if (typeof deps?.setInvestorStatus !== "function") throw new Error("investor status is not wired on this broker");
    const r = await deps.setInvestorStatus({
      contactId, addressHint: draft?.propertyAddress || "", status: "passed", reason: draft?.passReason || null,
    });
    if (!r?.ok) return r?.reason || "no deal to mark";
    return `passed on ${r.address}${r.reasonLabel ? ` — ${r.reasonLabel}` : ""}${r.warning ? ` (${r.warning})` : ""}`;
  },
  // Short of a pass: they pushed on price or told us why it doesn't work,
  // but they're still on the deal. Files the feedback and leaves them be.
  async record_deal_feedback({ deps, contactId, draft }) {
    if (typeof deps?.recordDealFeedback !== "function") throw new Error("deal feedback is not wired on this broker");
    if (!draft?.passReason) return "nothing they said reads as a reason";
    const r = await deps.recordDealFeedback({
      contactId, addressHint: draft?.propertyAddress || "", reason: draft.passReason,
    });
    if (!r?.ok) return r?.reason || "no deal to file it against";
    return `filed on ${r.address} — ${r.reasonLabel}`;
  },
  async mark_investor_committed({ deps, contactId, draft }) {
    if (typeof deps?.setInvestorStatus !== "function") throw new Error("investor status is not wired on this broker");
    const r = await deps.setInvestorStatus({ contactId, addressHint: draft?.propertyAddress || "", status: "committed" });
    if (!r?.ok) throw new Error(r?.reason || "no deal to mark");
    return `committed buyer on ${r.address}`;
  },
  async link_deal_evaluating({ deps, contactId, draft }) {
    if (typeof deps?.linkDealInterest !== "function") throw new Error("deal linking is not wired on this broker");
    const r = await deps.linkDealInterest({ contactId, addressHint: draft?.propertyAddress || "" });
    if (!r?.linked) throw new Error(r?.reason || "no deal to link");
    return r.unchanged ? `already ${r.status} on ${r.address}` : `evaluating ${r.address}`;
  },
  async start_underwrite({ deps, contactId, draft }) {
    if (typeof deps?.startUnderwrite !== "function") throw new Error("auto-underwrite is not wired on this broker");
    const r = await deps.startUnderwrite({ contactId, message: draft?.inbound || "", address: draft?.propertyAddress || "" });
    if (r?.skipped) throw new Error(r.skipped);
    return `underwrite started${r?.job?.dryRun ? " (dry run)" : ""}`;
  },
  // "That's way too low." Rather than conceding, re-run our own arithmetic on
  // the ARV and rehab THEY gave us and float what falls out. The reply itself
  // still parks for a person when the intent is a counter — this action sends
  // no text and moves no price of its own; it produces a revised offer, and
  // the revised number goes out as a fresh realm check.
  async requote_from_agent_numbers({ deps, contactId, draft }) {
    if (typeof deps?.requoteFromAgentNumbers !== "function") throw new Error("re-quoting is not wired on this broker");
    const r = await deps.requoteFromAgentNumbers({
      contactId, addressHint: draft?.propertyAddress || "", draftId: draft?.id || null,
    });
    if (!r?.ok) return r?.reason || "nothing to re-quote";
    return `re-ran ${r.address} on their numbers: ${fmtMoney(r.from)} → ${fmtMoney(r.to)}` +
      `${r.clamped ? ` (${r.basis})` : ""}${r.floated ? " — floating it now" : ""}`;
  },
  // The band said yes; this is the paper. Ask-only on any rule. It runs
  // unattended only when the reply agent injects it after the counter band
  // passed on this very message (their typed number, at or under the ceiling,
  // once per offer, capped per day).
  async revise_offer_to_counter({ deps, contactId, draft, action }) {
    if (typeof deps?.reviseOfferToCounter !== "function") throw new Error("re-issuing an offer is not wired on this broker");
    const amount = Math.round(Number(action?.amount ?? draft?.counterAmount) || 0);
    if (!amount) return "no number to re-issue at";
    const r = await deps.reviseOfferToCounter({ contactId, addressHint: draft?.propertyAddress || "", amount, draftId: draft?.id || null });
    if (!r?.ok) return r?.reason || "no offer to re-issue";
    return `re-issued ${r.address} at ${fmtMoney(amount)}`;
  },
  // Minting the deal sets a contract price and an assignment fee, fires GHL
  // writes and re-prices every dataroom built off the offer — on the evidence
  // of one sentence. A person confirms it.
  async promote_to_deal({ deps, contactId, draft }) {
    if (typeof deps?.promoteToDeal !== "function") throw new Error("promoting a deal is not wired on this broker");
    const r = await deps.promoteToDeal({ contactId, addressHint: draft?.propertyAddress || "", draftId: draft?.id || null });
    if (!r?.ok) return r?.reason || "no offer to promote";
    return `${r.address} is a deal`;
  },
  // The paper. Picks the agent's open offer (by the address the message
  // named, else the only one), and sends it the way the Send button would —
  // same documents, same channels, same double gate. Idempotent: an offer
  // that already went out is reported, not re-sent.
  async send_offer({ deps, contactId, draft, action }) {
    if (typeof deps?.sendOfferDocs !== "function") throw new Error("sending offers is not wired on this broker");
    const r = await deps.sendOfferDocs({
      contactId, addressHint: draft?.propertyAddress || "", channels: action?.channels, docs: action?.docs, draftId: draft?.id || null,
      ...(action?.afterCounter === true ? { afterCounter: true } : {}),
    });
    if (!r?.ok) return r?.reason || "no open offer to send";
    if (r.unchanged) return `offer on ${r.address} already went out ${r.sentAt ? `on ${String(r.sentAt).slice(0, 10)}` : ""}`.trim();
    if (r.dryRun) return `would send ${r.address} by ${(r.channels || []).join(" + ")} — sends are off on the broker`;
    return `sent the offer on ${r.address} by ${(r.channels || []).join(" + ")}`;
  },
  // The calendar. Runs unattended only when the booking guard passed on this
  // very message (the time was one we offered and is still free); a person
  // may also apply it from the row.
  async book_call({ deps, contactId, draft, action }) {
    if (typeof deps?.bookAppointment !== "function") throw new Error("booking is not wired on this broker");
    const startTime = String(action?.startTime || draft?.booking?.chosen?.iso || "").trim();
    if (!startTime) return "no time to book";
    const r = await deps.bookAppointment({ contactId, startTime, label: action?.label || draft?.booking?.chosen?.label || "", draftId: draft?.id || null, party: draft?.party || null });
    if (!r?.ok) throw new Error(r?.reason || "the calendar refused it");
    return `booked ${r.label || startTime}${r.calendarName ? ` on ${r.calendarName}` : ""}`;
  },
  // The same write as suggest_dataroom_invite, reached only through the
  // broker's guard (reply-agent.js) — it is not on any party's action list,
  // so a rule can never wire it.
  async send_dataroom_invite({ deps, contactId, draft }) {
    if (typeof deps?.issueDataroomInvite !== "function") throw new Error("dataroom invites are not wired on this broker");
    const r = await deps.issueDataroomInvite({ contactId, addressHint: draft?.propertyAddress || "" });
    return r?.sent ? `dataroom link texted for ${r.address}` : `dataroom link issued for ${r.address}${r?.reason ? ` — ${r.reason}` : ""}`;
  },
  async suggest_dataroom_invite({ deps, contactId, draft }) {
    if (typeof deps?.issueDataroomInvite !== "function") throw new Error("dataroom invites are not wired on this broker");
    const r = await deps.issueDataroomInvite({ contactId, addressHint: draft?.propertyAddress || "" });
    return r?.sent ? `dataroom link texted for ${r.address}` : `dataroom link issued for ${r.address}${r?.reason ? ` — ${r.reason}` : ""}`;
  },
};

/**
 * runActions({ client, locationId, contactId, draft, actions, deps }) → actions
 *
 * Runs each action in order and returns them with status "done" | "failed",
 * a `detail` line for the row, and `at`. Never throws.
 */
export async function runActions({ client, locationId, contactId, draft, actions = [], deps = {}, store = null }) {
  const out = [];
  for (const a of actions) {
    const exec = EXECUTORS[a.type];
    const at = new Date().toISOString();
    if (!exec) { out.push({ ...a, status: "failed", error: `unknown action ${a.type}`, at }); continue; }
    try {
      const detail = await exec({ client, locationId, contactId, draft, action: a, deps, store });
      out.push({ ...a, status: "done", detail: String(detail || "").slice(0, 200), at });
    } catch (e) {
      out.push({ ...a, status: "failed", error: String(e?.message || e).slice(0, 200), at });
    }
  }
  return out;
}
