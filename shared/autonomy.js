// autonomy.js — one dial for the self-driving features.
//
// The autopilot grew one switch at a time: an allowlist per party, a float
// per underwrite, a ladder per kind, a band, a re-quote, the offer itself,
// the outreach sweep, the dispo waves. Each is right on its own and together
// they are forty checkboxes across two tabs. Matt's ask on 2026-09-10: "a
// few modes — Off, Cautious, Normal, Fully Autonomous — and toggling one
// sets all the correct settings on our behalf."
//
// A mode is a fixed position for every switch. Applying one rewrites only
// the switches; every other setting (playbook text, ladder days, caps,
// calendars, workflows, persona) is kept as it was. Detecting one is the
// reverse: if the current switches equal what a mode would set, that's the
// mode; otherwise it is "custom", which the operator got to by hand and
// which no mode button quietly undoes.
//
// What the modes are, in one line each:
//   off       — the bot drafts nothing, sends nothing, nudges nobody.
//   cautious  — conversational replies send themselves; anything with a
//               number, a nudge, or a first text is drafted for you.
//   normal    — everything the gates allow sends itself: floats, nudges,
//               first texts, re-quotes, blasts. The offer, counters, calls
//               and invites still wait for you.
//   full      — plus the offer after a clean underwrite, yes to counters
//               under the ceiling, dataroom invites, and calendar booking.
//
// Pure. No I/O. The broker's env flags (CARD_SENDS_ENABLED and friends) are
// a separate veto this module cannot see; the switchboard shows those.

import { PARTIES, autoEligible, normalizeConversationAi } from "./conversation-ai.js";
import { kindsFor } from "./follow-up.js";

export const AUTONOMY_MODES = ["off", "cautious", "normal", "full"];

export const AUTONOMY_LABEL = {
  off: "Off",
  cautious: "Cautious",
  normal: "Normal",
  full: "Fully autonomous",
  custom: "Custom",
};

export const AUTONOMY_GLOSS = {
  off: "Nothing sends itself. No drafts, no nudges, no first texts.",
  cautious: "Plain conversation sends itself. Anything with a number, a nudge or a first text is drafted for you.",
  normal: "Everything the gates allow sends itself — floats, nudges, first texts, re-quotes, blasts. The offer, counters, calls and invites still wait for you.",
  full: "Normal, plus the offer after a clean underwrite, yes to counters under the ceiling, dataroom invites, and booking calls on the calendar.",
  custom: "Switches were set by hand and match no mode. Picking a mode replaces them.",
};

// What each mode does, as the lines the button's confirm shows.
export const AUTONOMY_DOES = {
  off: [
    "Conversation AI off — every inbound waits for you",
    "Outreach sweep, auto-blasts, auto-invites and paperwork off",
  ],
  cautious: [
    "Replies to questions, small talk, status checks, rejections and 'still interested' send themselves",
    "Floats, nudges, first texts and blasts are drafted, never sent",
    "Holds any reply the model flags as needing a person; medium-confidence reads wait too",
    "Offer, counters, calls, invites: yours",
  ],
  normal: [
    "Every auto-eligible reply sends itself, for agents and investors",
    "Realm check and take check float our numbers on their own",
    "Follow-up ladders run and send: offer, outreach, blast, dataroom",
    "Outreach sweep imports and texts new agents daily; re-quotes on their numbers",
    "Deal blasts go out on promote; the assignment drafts on commit",
    "A number we promised goes out when it is ready; a held underwrite asks for their numbers and re-runs on them",
    "The audit's fixes run every two hours in the working day too, not only at 7pm",
    "A priced offer nobody floated is floated after four hours; a thread gone quiet is marked no response; a failed underwrite is retried once",
    "Offer, counters, calls, dataroom invites: yours",
  ],
  full: [
    "Everything in Normal",
    "The offer sends itself after a clean underwrite, and when they say the number works",
    "Yes to a counter at or under the ceiling, and to an acceptance",
    "Yes to a buyer's own number, never under contract plus the minimum fee, once per deal",
    "Dataroom invites go to evaluating buyers whose buy box fits",
    "Calls are booked on the calendar when one is picked in Settings",
  ],
};

// Cautious: the intents whose reply carries no number and commits to
// nothing — the ones an operator ticks first. Everything outbound (floats,
// nudges, first texts, blasts) stays a draft.
const CAUTIOUS_INTENTS = {
  agent: ["deal_available", "new_property", "investor_open", "question", "rejection", "status_check", "small_talk", "media", "call_followup"],
  investor: ["interested", "looking_for_deals", "buybox_update", "question", "passing", "status_check", "small_talk", "media", "call_followup"],
};

const intentsFor = (party, mode) => {
  const eligible = autoEligible(party);
  if (mode === "cautious") return CAUTIOUS_INTENTS[party].filter((i) => eligible.includes(i));
  if (mode === "normal" || mode === "full") return eligible;
  return [];
};

/**
 * autonomyPlan(mode, { hasCalendar }) → the switch positions
 *
 * The table, as data. `hasCalendar` decides whether "full" may switch booking
 * on: without a calendar picked the guard cannot offer a slot, so the switch
 * stays off and the mode still matches.
 */
export function autonomyPlan(mode, { hasCalendar = false } = {}) {
  if (!AUTONOMY_MODES.includes(mode)) throw new Error(`unknown autonomy mode: ${mode}`);
  const on = mode !== "off";
  const normal = mode === "normal" || mode === "full";
  const full = mode === "full";
  return {
    enabled: on,
    autoSend: {
      holdOnNeedsHuman: mode === "cautious",
      minConfidence: mode === "cautious" ? "high" : "medium",
    },
    parties: Object.fromEntries(PARTIES.map((party) => [party, {
      autoSend: { enabled: on && intentsFor(party, mode).length > 0, intents: intentsFor(party, mode) },
      followUp: normal,
      ...(party === "agent" ? {
        realmCheck: on,
        takeCheck: on,
        lessons: on,
        outreach: normal,
        requote: normal,
        counterBand: full,
        sendOfferOnClearUnderwrite: full,
        sendOfferUnasked: full,
      } : {
        // The investor band: a buyer's own number, above contract plus the
        // minimum fee, once per deal. Full only.
        priceBand: full,
      }),
    }])),
    booking: full && hasCalendar,
    outreachAutopilot: normal,
    dispoAutopilot: { autoBlastOnPromote: normal, paperworkOnCommit: normal, autoInvite: full },
    // What the machine does by itself instead of putting a row on Today.
    driver: { promises: normal, daytime: normal, timers: normal },
  };
}

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

// The send_offer action on the agent's intent rules: the mode is a ceiling
// on the rule, and its own `mode` on the action. Full sets both to auto on
// the realm_yes rule (adding the action if the rule lacks it); every other
// mode sets every send_offer action back to ask. No other action is touched.
function setSendOfferActions(agent, unasked) {
  const rules = agent.intentRules && typeof agent.intentRules === "object" ? agent.intentRules : {};
  for (const [intent, rule] of Object.entries(rules)) {
    if (!rule || typeof rule !== "object") continue;
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    let has = false;
    for (const a of actions) {
      if (a?.type !== "send_offer") continue;
      has = true;
      a.mode = unasked ? "auto" : "ask";
    }
    if (has && unasked) rule.mode = "auto";
    if (intent === "realm_yes" && unasked && !has) {
      rule.mode = "auto";
      rule.actions = [...actions, { type: "send_offer", mode: "auto" }];
    }
  }
  // No realm_yes rule at all (a blob that never loaded the starter): full
  // still means "send it when they say the number works", so make the rule.
  if (unasked && !(rules.realm_yes && typeof rules.realm_yes === "object")) {
    rules.realm_yes = { mode: "auto", actions: [{ type: "send_offer", mode: "auto" }] };
  }
  agent.intentRules = rules;
}

/**
 * applyAutonomy(saved, mode) → saved'
 *
 * A new settings blob with every switch at the mode's position and nothing
 * else changed. `saved` is the location's settings document (the one with
 * conversationAi / outreachAutopilot / dispoAutopilot on it). The
 * Conversation AI blob comes back normalized, the way its own route saves it.
 */
export function applyAutonomy(saved = {}, mode) {
  const s = saved && typeof saved === "object" ? saved : {};
  const cfg = normalizeConversationAi(clone(s.conversationAi));
  const plan = autonomyPlan(mode, { hasCalendar: Boolean(cfg.booking?.calendarId) });

  cfg.enabled = plan.enabled;
  cfg.autoSend = { ...cfg.autoSend, ...plan.autoSend };
  cfg.booking = { ...cfg.booking, enabled: plan.booking };
  cfg.driver = { ...cfg.driver, promises: { ...cfg.driver?.promises, enabled: plan.driver.promises }, daytime: { ...cfg.driver?.daytime, enabled: plan.driver.daytime }, timers: { ...cfg.driver?.timers, enabled: plan.driver.timers } };
  for (const party of PARTIES) {
    const pb = cfg.parties[party];
    const p = plan.parties[party];
    pb.autoSend = { enabled: p.autoSend.enabled, intents: [...p.autoSend.intents] };
    const ladders = {};
    for (const kind of kindsFor(party)) ladders[kind] = { ...(pb.followUp?.ladders?.[kind] || {}), enabled: p.followUp };
    pb.followUp = { ...pb.followUp, enabled: p.followUp, ladders };
    if (party === "agent") {
      pb.realmCheck = { ...pb.realmCheck, enabled: p.realmCheck };
      pb.takeCheck = { ...pb.takeCheck, enabled: p.takeCheck };
      pb.lessons = { ...pb.lessons, enabled: p.lessons };
      pb.outreach = { ...pb.outreach, enabled: p.outreach };
      pb.requote = { ...pb.requote, enabled: p.requote };
      pb.counterBand = { ...pb.counterBand, enabled: p.counterBand, acceptance: p.counterBand };
      pb.sendOffer = { ...pb.sendOffer, onClearUnderwrite: p.sendOfferOnClearUnderwrite };
      setSendOfferActions(pb, p.sendOfferUnasked);
    } else {
      pb.priceBand = { ...pb.priceBand, enabled: p.priceBand };
    }
  }

  const outreachAutopilot = { ...(s.outreachAutopilot && typeof s.outreachAutopilot === "object" ? s.outreachAutopilot : {}), enabled: plan.outreachAutopilot };
  const dispoAutopilot = { ...(s.dispoAutopilot && typeof s.dispoAutopilot === "object" ? s.dispoAutopilot : {}), ...plan.dispoAutopilot };

  return { ...s, conversationAi: normalizeConversationAi(cfg), outreachAutopilot, dispoAutopilot };
}

/**
 * autonomyFingerprint(saved) → the switch positions as they stand
 *
 * Same shape as autonomyPlan's output, read off a settings blob, so the two
 * can be compared. Intent lists are sorted; ladders collapse to "all on".
 */
export function autonomyFingerprint(saved = {}) {
  const s = saved && typeof saved === "object" ? saved : {};
  const cfg = normalizeConversationAi(clone(s.conversationAi));
  const oa = s.outreachAutopilot && typeof s.outreachAutopilot === "object" ? s.outreachAutopilot : {};
  const da = s.dispoAutopilot && typeof s.dispoAutopilot === "object" ? s.dispoAutopilot : {};
  const parties = {};
  for (const party of PARTIES) {
    const pb = cfg.parties[party];
    const kinds = kindsFor(party);
    const laddersOn = Boolean(pb.followUp?.enabled) && kinds.every((k) => pb.followUp?.ladders?.[k]?.enabled);
    const laddersOff = !pb.followUp?.enabled || kinds.every((k) => !pb.followUp?.ladders?.[k]?.enabled);
    const intents = pb.autoSend?.enabled ? [...(pb.autoSend.intents || [])].sort() : [];
    parties[party] = {
      autoSend: { enabled: intents.length > 0, intents },
      // A half-on ladder set is neither: it reads as null and matches no mode.
      followUp: laddersOn ? true : laddersOff ? false : null,
      ...(party === "agent" ? {
        realmCheck: Boolean(pb.realmCheck?.enabled),
        takeCheck: Boolean(pb.takeCheck?.enabled),
        lessons: Boolean(pb.lessons?.enabled),
        outreach: Boolean(pb.outreach?.enabled),
        requote: Boolean(pb.requote?.enabled),
        counterBand: Boolean(pb.counterBand?.enabled),
        sendOfferOnClearUnderwrite: Boolean(pb.sendOffer?.onClearUnderwrite),
        sendOfferUnasked: Object.values(pb.intentRules || {}).some((r) =>
          r?.mode === "auto" && (r.actions || []).some((a) => a?.type === "send_offer" && a.mode === "auto")),
      } : {
        priceBand: Boolean(pb.priceBand?.enabled),
      }),
    };
  }
  return {
    enabled: Boolean(cfg.enabled),
    autoSend: { holdOnNeedsHuman: Boolean(cfg.autoSend?.holdOnNeedsHuman), minConfidence: cfg.autoSend?.minConfidence },
    parties,
    booking: Boolean(cfg.booking?.enabled),
    outreachAutopilot: oa.enabled === true,
    dispoAutopilot: { autoBlastOnPromote: da.autoBlastOnPromote === true, paperworkOnCommit: da.paperworkOnCommit === true, autoInvite: da.autoInvite === true },
    driver: { promises: Boolean(cfg.driver?.promises?.enabled), daytime: Boolean(cfg.driver?.daytime?.enabled), timers: Boolean(cfg.driver?.timers?.enabled) },
  };
}

const sortedPlan = (plan) => {
  const p = clone(plan);
  for (const party of PARTIES) p.parties[party].autoSend.intents.sort();
  return p;
};

/**
 * detectAutonomy(saved) → "off" | "cautious" | "normal" | "full" | "custom"
 *
 * Off is off whatever else is set: a bot that is switched off is doing
 * nothing, and that is the fact the dial should show.
 */
export function detectAutonomy(saved = {}) {
  const fp = autonomyFingerprint(saved);
  if (!fp.enabled) return "off";
  const cfg = normalizeConversationAi(clone(saved?.conversationAi));
  const hasCalendar = Boolean(cfg.booking?.calendarId);
  for (const mode of AUTONOMY_MODES) {
    if (mode === "off") continue;
    if (JSON.stringify(sortedPlan(autonomyPlan(mode, { hasCalendar }))) === JSON.stringify(fp)) return mode;
  }
  return "custom";
}

/**
 * autonomyTurnsDown(saved, mode) → boolean
 *
 * Does moving to `mode` take anything away from what is running now? The dial
 * holds every reply that is counting down when it does, and only then: a
 * location that reads Custom because new switches shipped, pressing its own
 * mode again, is adding to what it had, and its replies should keep their
 * minute. Down is a switch going off (a half-on ladder set going off counts,
 * going fully on does not), an intent leaving an auto-send list, or the send
 * rules getting stricter.
 */
export function autonomyTurnsDown(saved = {}, mode) {
  const have = autonomyFingerprint(saved);
  const want = autonomyFingerprint(applyAutonomy(saved, mode));
  let down = false;
  const walk = (a, b, path) => {
    if (down) return;
    if (Array.isArray(a) || Array.isArray(b)) { down = (a || []).some((x) => !(b || []).includes(x)); return; }
    if (a && typeof a === "object" && b && typeof b === "object") {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k);
      return;
    }
    if (a === b) return;
    if (path === "autoSend.holdOnNeedsHuman") down = b === true;
    else if (path === "autoSend.minConfidence") down = b === "high";
    else down = b !== true;                       // a half-on ladder set (null) going fully on takes nothing away
  };
  walk(have, want, "");
  return down;
}

/**
 * dialHeldReleasable(draft, saved, now) → { ok, reason }
 *
 * The undo for a hold the dial made. May this draft go back on a clock? Only
 * one the dial itself pulled back, in the last day, that had passed the gates
 * and that the dial as it stands now would still send by itself. It reads the
 * allowlist and never widens it; the scheduler's own checks at send time (a
 * person answered since, sends off, the caps) still apply.
 */
const DIAL_HOLD_RX = /^held: the autopilot was set to /;
export function dialHeldReleasable(draft = {}, saved = {}, now = Date.now()) {
  const no = (reason) => ({ ok: false, reason });
  if (draft.status !== "draft") return no(`the draft is ${draft.status || "gone"}`);
  if (!(draft.flags || []).some((f) => DIAL_HOLD_RX.test(String(f)))) return no("not held by the dial");
  const heldMs = Date.parse(draft.heldAt || "");
  if (!Number.isFinite(heldMs) || now - heldMs > 24 * 3600000) return no("held more than a day ago");
  if (draft.gateClean !== true) return no("it had not passed the gates");
  if (draft.needsHuman) return no("it was flagged for a person");
  const cfg = normalizeConversationAi(clone(saved?.conversationAi));
  if (!cfg.enabled) return no("the Conversation AI is off");
  const party = draft.party === "investor" ? "investor" : "agent";
  const auto = cfg.parties?.[party]?.autoSend;
  if (!auto?.enabled || !(auto.intents || []).includes(draft.intent)) return no(`${String(draft.intent || "it").replace(/_/g, " ")} is not on the ${party} auto-send list`);
  return { ok: true, reason: "" };
}

// For a switchboard line: which switches differ from a given mode, by name.
export function autonomyDiff(saved = {}, mode) {
  const cfg = normalizeConversationAi(clone(saved?.conversationAi));
  const want = sortedPlan(autonomyPlan(mode, { hasCalendar: Boolean(cfg.booking?.calendarId) }));
  const have = autonomyFingerprint(saved);
  const out = [];
  const walk = (a, b, path) => {
    if (Array.isArray(a) || Array.isArray(b)) { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(path); return; }
    if (a && typeof a === "object" && b && typeof b === "object") {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k);
      return;
    }
    if (a !== b) out.push(path);
  };
  walk(want, have, "");
  return out;
}
