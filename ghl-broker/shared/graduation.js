// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// graduation.js — is an intent ready to send itself, and what is the
// autopilot actually doing right now.
//
// The rule Matt set when the Conversation AI shipped: when "sent as written"
// matches "auto-sendable" for a couple of weeks, tick that intent on the
// allowlist. Nobody was measuring it, so nothing ever graduated. This turns
// draftStats() into a verdict per intent, and the config into a plain list of
// switches with a state each, so the state of the machine is one glance.
//
// Pure. Takes the stats the history endpoint already computes and the
// normalized config; returns plain objects. No clock, no I/O.

import {
  INTENTS, OUTBOUND_INTENTS, NEVER_AUTO, INTENT_LABEL, PARTY_LABEL, PARTIES, autoEligible,
} from "./conversation-ai.js";
import { FOLLOW_UP_KINDS, kindsFor } from "./follow-up.js";

// A person has to have judged this many drafts, and sent this share of them
// untouched, before the intent is called ready. Twenty is small on purpose:
// at ten offers a day the common intents clear it in a week, and the rare
// ones (proof of funds, scheduling) never will — which is the right answer
// for a rare intent.
export const GRADUATION = Object.freeze({ minVerdicts: 20, minAsWrittenPct: 90, windowDays: 14 });

export const VERDICT_STATES = ["on", "ready", "not_yet", "not_enough", "locked"];
export const VERDICT_LABEL = {
  on: "sends itself",
  ready: "ready",
  not_yet: "not yet",
  not_enough: "not enough yet",
  locked: "never",
};

/**
 * verdictsIn(cell) → number
 *
 * How many times a person actually judged a draft: sent it as written, sent
 * it edited, or dismissed it. A draft that sent itself is not a verdict, and
 * a draft still waiting is not one either.
 */
export function verdictsIn(cell = {}) {
  return (cell.humanSentUnedited || 0) + (cell.sentEdited || 0) + (cell.dismissed || 0);
}

/**
 * intentVerdict({ party, intent, cell, playbook }) → verdict
 *
 *   { party, intent, label, state, verdicts, asWritten, pct, needed }
 *
 * `needed` is how many more verdicts before the rule can decide — 0 when it
 * already has enough. `pct` is null until there is at least one verdict.
 */
export function intentVerdict({ party, intent, cell = {}, playbook = {}, rule = GRADUATION }) {
  const label = INTENT_LABEL[party]?.[intent] || intent;
  const base = { party, intent, label, verdicts: 0, asWritten: 0, pct: null, needed: rule.minVerdicts };
  if ((NEVER_AUTO[party] || []).includes(intent)) return { ...base, state: "locked" };
  const verdicts = verdictsIn(cell);
  const asWritten = cell.humanSentUnedited || 0;
  const pct = verdicts ? Math.round((asWritten / verdicts) * 100) : null;
  const needed = Math.max(0, rule.minVerdicts - verdicts);
  const on = Boolean(playbook.autoSend?.enabled) && (playbook.autoSend?.intents || []).includes(intent);
  let state;
  if (on) state = "on";
  else if (needed > 0) state = "not_enough";
  else if (pct >= rule.minAsWrittenPct) state = "ready";
  else state = "not_yet";
  return { ...base, state, verdicts, asWritten, pct, needed };
}

const STATE_ORDER = { ready: 0, not_yet: 1, not_enough: 2, on: 3, locked: 4 };

/**
 * graduationReport({ stats, config }) → { byParty: { agent: [verdict], investor: [verdict] }, ready: number }
 *
 * Every intent that could ever auto-send, whether or not it has been seen in
 * the window, so the list is stable and an operator learns the vocabulary.
 * Ready ones first.
 */
export function graduationReport({ stats = {}, config = {}, rule = GRADUATION } = {}) {
  const byParty = {};
  let ready = 0;
  for (const party of PARTIES) {
    const cells = stats.byParty?.[party]?.byIntent || {};
    const playbook = config.parties?.[party] || {};
    const intents = [...(INTENTS[party] || []), ...(OUTBOUND_INTENTS[party] || [])];
    const rows = intents.map((intent) => intentVerdict({ party, intent, cell: cells[intent], playbook, rule }));
    rows.sort((a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || (b.verdicts - a.verdicts) || a.label.localeCompare(b.label));
    byParty[party] = rows;
    ready += rows.filter((r) => r.state === "ready").length;
  }
  return { byParty, ready, rule };
}

/* ---------- the switchboard ---------- */

// Three states, in the order an operator cares: is it doing the thing on
// its own, is it only drafting for me, or is it off. "drafting" is the
// shakedown mode every automation ships in — the ladder is on but the nudge
// intent isn't on the allowlist yet, so the queue fills and nothing leaves.
export const SWITCH_STATES = ["on", "drafting", "off"];

const sw = (key, label, state, note = "", group = "conversation") => ({ key, label, state, note, group });

/**
 * autopilotSummary({ config, sendsEnabled, underwriteLive, underwriteWired }) → { switches, counts }
 *
 * `config` is the normalized Conversation AI blob. The env facts come from the
 * caller because a pure module cannot read process.env.
 */
export function autopilotSummary({ config = {}, sendsEnabled = false, underwriteLive = false, underwriteWired = true, outreach = null, importsEnabled = false } = {}) {
  const out = [];
  const parties = config.parties || {};

  out.push(sw("sends", "Broker can send", sendsEnabled ? "on" : "off",
    sendsEnabled ? "" : "CARD_SENDS_ENABLED is not set — nothing leaves, by you or by itself", "broker"));
  out.push(sw("conversation", "Conversation AI", config.enabled ? (sendsEnabled ? "on" : "drafting") : "off",
    config.enabled ? "" : "no drafts, no actions", "broker"));
  out.push(sw("underwrite", "Auto-underwrite", !underwriteWired ? "off" : underwriteLive ? "on" : "drafting",
    !underwriteWired ? "no webhook secret configured" : underwriteLive ? "publishes offers to History" : "AUTO_UNDERWRITE_ENABLED is not set — every run is a dry run", "broker"));

  for (const party of PARTIES) {
    const pb = parties[party] || {};
    const allow = pb.autoSend?.enabled ? (pb.autoSend.intents || []) : [];
    const eligible = autoEligible(party);
    const canSend = config.enabled && sendsEnabled;
    const plural = `${PARTY_LABEL[party] || party}s`.toLowerCase();

    out.push(sw(`autosend:${party}`, `Replies to ${plural}`,
      !config.enabled ? "off" : allow.length && canSend ? "on" : "drafting",
      !config.enabled ? "" : allow.length ? `${allow.length} of ${eligible.length} intents send themselves` : "every reply waits for you", party));

    if (party === "agent") {
      // The top of the funnel: a daily pull and a capped import, then the
      // first text. `outreach` is the location's outreachAutopilot settings.
      const oa = outreach || {};
      out.push(sw("outreach_pull", "Daily listing pull + import",
        !oa.enabled ? "off" : importsEnabled ? "on" : "drafting",
        !oa.enabled ? "new agents are pulled and imported by hand"
          : importsEnabled ? `up to ${oa.dailyCap || 12} new agents a day` : "OUTREACH_IMPORTS_ENABLED is not set — pulls run, imports are dry runs", party));
      const fo = pb.outreach?.enabled;
      out.push(sw("outreach_open", "First text to a new agent", !fo ? "off" : allow.includes("outreach_open") && canSend ? "on" : "drafting",
        fo ? "" : "the first text is a GHL workflow template, not the bot", party));
      const rc = pb.realmCheck?.enabled, tc = pb.takeCheck?.enabled;
      out.push(sw("take_check", "Float our read", !tc ? "off" : allow.includes("take_check") && canSend ? "on" : "drafting",
        tc ? "" : "asks the agent for their ARV and rehab before our price", party));
      out.push(sw("realm_check", "Realm check", !rc ? "off" : allow.includes("realm_check") && canSend ? "on" : "drafting",
        rc ? "" : "floats the cash number before the formal offer", party));
      const band = pb.counterBand || {};
      out.push(sw("counter_band", "Counter band", band.enabled && canSend ? "on" : "off",
        band.enabled ? `says yes to counters under the ceiling, ${band.dailyCap}/day` : "counters always wait for you", party));
      const rq = pb.requote || {};
      out.push(sw("requote", "Re-quote on their numbers", rq.enabled ? "on" : "off",
        rq.enabled ? "" : "'too low' is answered by you", party));
    }

    const fu = pb.followUp || {};
    for (const kind of kindsFor(party)) {
      const ladder = fu.ladders?.[kind] || {};
      const live = fu.enabled && ladder.enabled;
      const state = !live ? "off" : allow.includes(kind) && canSend ? "on" : "drafting";
      out.push(sw(`ladder:${kind}`, FOLLOW_UP_KINDS[kind]?.label || kind, state,
        live ? `day ${(ladder.steps || []).join(", ")}` : "nobody is nudged", party));
    }
  }

  const counts = { on: 0, drafting: 0, off: 0 };
  for (const s of out) counts[s.state]++;
  return { switches: out, counts };
}
