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

let seq = 0;
const newActionId = () => `a-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * planActions({ party, intent, confidence, playbook }) → { auto, suggested }
 *
 * Pure. Each returned action is { id, type, mode, status: "pending", ...params }.
 * A rule in auto mode still waits for a person when the model was not sure:
 * a wrongly-tagged contact starts a GHL workflow that texts people.
 */
export function planActions({ party, intent, confidence = "low", playbook = {} }) {
  const rule = playbook?.intentRules?.[intent];
  if (!rule || !Array.isArray(rule.actions) || !rule.actions.length) return { auto: [], suggested: [] };
  const auto = [];
  const suggested = [];
  for (const a of rule.actions) {
    const askOnly = ASK_ONLY_ACTIONS.has(a.type);
    const mode = askOnly ? "ask" : rule.mode === "auto" ? "auto" : "ask";
    const action = { ...a, id: newActionId(), mode, status: "pending", party };
    if (mode === "auto" && confidence === "high") auto.push(action);
    else suggested.push(action);
  }
  return { auto, suggested };
}

const EXECUTORS = {
  async add_tags({ client, contactId, action }) {
    await addContactTags(client, contactId, action.tags);
    return `tagged ${action.tags.join(", ")}`;
  },
  async remove_tags({ client, contactId, action }) {
    await removeContactTags(client, contactId, action.tags);
    return `removed ${action.tags.join(", ")}`;
  },
  async set_field({ client, locationId, contactId, action, draft }) {
    const value = substituteTokens(action.value, draft).trim();
    // A template whose tokens all came up empty ({{propertyAddress}} on a
    // message that named no property) must not blank a field that had a
    // value — the Subject Property field aims the underwriter.
    if (!value && /\{\{/.test(action.value || "")) return `${action.key}: nothing to write`;
    const id = await findOrCreateCustomFieldByKey(client, locationId, action.key, action.key, "TEXT");
    if (!id) throw new Error(`could not find or create the field ${action.key}`);
    await updateContact(client, contactId, { customFields: [{ id, value }] });
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
    const r = await deps.setOfferStatus({ contactId, addressHint: draft?.propertyAddress || "", status: "countered", note });
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
  async mark_investor_passed({ deps, contactId, draft }) {
    if (typeof deps?.setInvestorStatus !== "function") throw new Error("investor status is not wired on this broker");
    const r = await deps.setInvestorStatus({ contactId, addressHint: draft?.propertyAddress || "", status: "passed" });
    if (!r?.ok) return r?.reason || "no deal to mark";
    return `passed on ${r.address}`;
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
export async function runActions({ client, locationId, contactId, draft, actions = [], deps = {} }) {
  const out = [];
  for (const a of actions) {
    const exec = EXECUTORS[a.type];
    const at = new Date().toISOString();
    if (!exec) { out.push({ ...a, status: "failed", error: `unknown action ${a.type}`, at }); continue; }
    try {
      const detail = await exec({ client, locationId, contactId, draft, action: a, deps });
      out.push({ ...a, status: "done", detail: String(detail || "").slice(0, 200), at });
    } catch (e) {
      out.push({ ...a, status: "failed", error: String(e?.message || e).slice(0, 200), at });
    }
  }
  return out;
}
