// pipeline-ops.js — what the board's buttons actually do.
//
// The pipeline endpoint names each op by a key and says nothing about how it
// is carried out; this is the one place those keys become API calls, so the
// pure module stays free of the console and the console stays free of
// guesswork. Every op returns whatever the call returned; the view refreshes
// after any of them.

import {
  applyDraftAction, deleteOffer, floatOffer, getFollowUps, matchInvestorsToDeal, offerEditorUrl,
  runFollowUps, setOfferStatus, updateDeal,
} from "./api.js";

// Ops that open somewhere rather than change something.
export function linkFor(key, item) {
  switch (key) {
    case "open_editor": return item.offerId ? offerEditorUrl(item.offerId) : null;
    case "open_deals": return item.offerId ? offerEditorUrl(item.offerId, { view: "deals" }) : null;
    default: return null;
  }
}

// Ops a person should be asked about first: they end something.
export const CONFIRM = {
  drop: (i) => `Drop the held underwrite on ${i.address || "this property"}? The draft is deleted.`,
  fell_through: (i) => `Mark ${i.address || "this deal"} as fallen through?`,
  mark_passed: (i) => `Mark the offer on ${i.address || "this property"} as passed?`,
};

export async function runOp(key, item) {
  switch (key) {
    case "apply":              return applyDraftAction(item.draftId, item.actionId);
    case "drop":               return deleteOffer(item.offerId);
    case "float_take":         return floatOffer(item.offerId, "take_check");
    case "float_realm":        return floatOffer(item.offerId, "realm_check");
    case "mark_no_response":   return setOfferStatus(item.offerId, "no_response", "from the pipeline board");
    case "mark_passed":        return setOfferStatus(item.offerId, "passed", "from the pipeline board");
    case "mark_closed":        return updateDeal(item.offerId, { stage: "closed" });
    case "fell_through":       return updateDeal(item.offerId, { stage: "fell_through" });
    case "advance":            return updateDeal(item.offerId, { stage: "buyer_found" });
    case "match_investors":    return matchInvestorsToDeal(item.offerId);
    case "preview_follow_ups": return getFollowUps(true);
    case "run_follow_ups":     return runFollowUps(false);
    default: throw new Error(`no such op: ${key}`);
  }
}

// A one-line read of what an op returned, for the toast under the button.
export function describeResult(key, r) {
  if (!r) return "";
  if (key.startsWith("float_")) return r.skipped ? `Didn't: ${r.skipped}` : "Drafting it now — check the outbox.";
  if (key === "preview_follow_ups") {
    const due = (r.candidates || []).filter((c) => c.due);
    return due.length ? `${due.length} would get a nudge today: ${due.slice(0, 4).map((c) => c.address).join(", ")}${due.length > 4 ? "…" : ""}` : "Nobody is due a nudge today.";
  }
  if (key === "run_follow_ups") return "Sweep started — drafts land in the outbox.";
  if (key === "match_investors") {
    const n = (r.matches || r.investors || []).length;
    return n ? `${n} buyer${n === 1 ? "" : "s"} fit — open the deal to add them.` : "No buyers fit this one yet.";
  }
  if (key === "apply") return r.action?.detail || "Done.";
  return "Done.";
}
