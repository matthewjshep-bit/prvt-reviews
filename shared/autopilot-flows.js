// autopilot-flows.js — what goes out to agents and to buyers, in order, as
// a chart (Autopilot → Agents and Investors, 2026-10-20).
//
// Matt: "The main things I care about are what is actually going out to
// agents initially, what is going out to agents as a follow-up, and then
// same thing with investors … charted out … like a Make.com or Go High Level
// automation." Each flow is a list of steps — a trigger, a text, a wait, a
// branch for their reply, a loop for the check-ins — read off the live
// settings, each text with what it says and whether it sends itself.
//
// Pure. Whether a step sends itself is the switchboard's call
// (shared/graduation.js autopilotSummary), passed in as `switches`, so the
// chart and the switch list can never disagree.

import { normalizeOpener } from "./outreach-opener.js";
import { normalizeAgentPulse } from "./agent-pulse.js";
import { normalizeBuyerPulse } from "./buyer-pulse.js";
import { NUDGE_TEXTS, CHECKIN_TEXTS } from "./standard-texts.js";
import { DEFAULT_LADDERS } from "./follow-up.js";

// The words on a step's pill.
export const FLOW_STATUS_LABEL = { on: "Sends itself", drafting: "Drafts for you", off: "Off", ghl: "Sent by GHL", auto: "Runs itself", dry: "Dry run" };

const stateOf = (switches, key, fallback = "off") => (switches || []).find((s) => s.key === key)?.state || fallback;
// A switch the switchboard doesn't list (the two pulses): off, a draft, or
// sending when the broker may send.
const ownState = (enabled, autoSend, switches) => (!enabled ? "off" : autoSend && stateOf(switches, "sends") === "on" ? "on" : "drafting");
// A trigger doesn't send anything: it runs, or it's a dry run, or it's off.
const triggerState = (state) => (state === "on" ? "auto" : state === "drafting" ? "dry" : "off");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * agentFlow({ settings, config, switches }) → step[]
 *
 * `settings` the offer settings (outreachAutopilot), `config` the normalized
 * Conversation AI blob, `switches` autopilotSummary().switches. A step is
 * { id, type, title, detail, status?, texts?, edit? }: `texts` are what goes
 * out ({first} and {address} filled in per agent), `edit` names what the
 * chart may change on it.
 */
export function agentFlow({ settings = {}, config = {}, switches = [] } = {}) {
  const oa = settings.outreachAutopilot || {};
  const opener = normalizeOpener(oa.opener);
  const pulse = normalizeAgentPulse(oa.pulse);
  const ladder = config.parties?.agent?.followUp?.ladders?.outreach_nudge || DEFAULT_LADDERS.outreach_nudge;
  const firstTouch = oa.firstTouch || "app";
  const ai = opener.mode === "ai";
  const steps = [];

  steps.push({ id: "found", type: "trigger", title: "A new listing agent is found",
    detail: oa.enabled ? `Weekday sweep at 10am: listings that need work, up to ${oa.dailyCap || 12} new agents a day` : "The daily sweep is off: agents are pulled and imported by hand",
    status: triggerState(stateOf(switches, "outreach_pull")) });

  if (firstTouch !== "app") {
    steps.push({ id: "first", type: "text", title: "First text",
      detail: `Sent by ${firstTouch === "workflow" ? "your GHL workflow" : "the GHL agent-outreach template"}. Its wording lives in GHL.`, status: "ghl" });
  } else {
    steps.push({ id: "first", type: "text", title: "First text",
      detail: `${ai ? "The bot writes one in your voice from these" : `One of these ${opener.examples.length}, a different one per agent`}. GHL adds "Thanks, Matt" and the stop line.`,
      status: stateOf(switches, "outreach_open"), texts: opener.examples, edit: { field: "examples" } });
  }

  const ladderOn = stateOf(switches, "ladder:outreach_nudge");
  (ladder.steps || []).forEach((day, i) => {
    steps.push({ id: `wait-${i}`, type: "wait", title: `Wait until day ${day}`, detail: "if they haven't replied", day });
    const own = opener.followUps[i];
    steps.push({ id: `follow-${i}`, type: "text", title: `Follow-up ${i + 1}`,
      detail: own ? "" : "No text of its own: one of the spare follow-ups", status: ladderOn,
      texts: [own || NUDGE_TEXTS[i % NUDGE_TEXTS.length]], day, edit: { field: "followUp", index: i } });
  });
  if (oa.followUpEnabled) {
    steps.push({ id: "ghl-follow", type: "text", title: `GHL follow-up workflow, day ${oa.followUpDays || 14}`,
      detail: "Agents GHL texted first get your GHL follow-up workflow. Its wording lives in GHL.", status: "ghl" });
  }

  steps.push({ id: "reply", type: "branch", title: "They reply",
    detail: "Every follow-up stops. The bot answers in your voice and asks for their other fixers, on or off market.",
    status: stateOf(switches, "autosend:agent") });

  steps.push({ id: "checkin", type: "loop", title: `Check in every ${pulse.everyDays} days`,
    detail: `Agents who've talked to us get one of these. One who never wrote back hears from us only about a fresh listing of theirs that needs work, every ${pulse.coldEveryDays} days at most, starting "it's Matt, I fix up houses locally".`,
    status: ownState(pulse.enabled, pulse.autoSend, switches),
    texts: pulse.mode === "ai" ? [] : [...CHECKIN_TEXTS], edit: { field: "pulse" } });
  return steps;
}

/**
 * investorFlow({ settings, config, switches, samples }) → { deal: step[], between: step[], note }
 *
 * The deal's texts from the day it's promoted, then the check-in between
 * deals. `samples` is the deal text as a buyer would get it now
 * (GET /api/dispo/waves/preview), when a deal is picked.
 */
export function investorFlow({ settings = {}, config = {}, switches = [], samples = [] } = {}) {
  const da = settings.dispoAutopilot || {};
  const n = (k, d) => (da[k] == null || da[k] === "" ? d : Number(da[k]));
  const pulse = normalizeBuyerPulse(da.pulse);
  const followUp = config.parties?.investor?.followUp?.ladders?.deal_followup || DEFAULT_LADDERS.deal_followup;
  const showings = da.showings || {};
  const viaGhl = da.sendWith === "ghl";
  const auto = Boolean(da.autoBlastOnPromote);
  const blast = viaGhl ? "ghl" : stateOf(switches, "blast");
  const maxWaves = n("maxWaves", 2);
  const deal = [];

  deal.push({ id: "promoted", type: "trigger", title: "A deal goes under contract",
    detail: auto ? "You promote the offer to a deal; the first wave picks itself" : "Waves don't start on their own: you pick the buyers from the deal",
    status: triggerState(stateOf(switches, "auto_blast")) });
  if (auto) deal.push({ id: "wait-promote", type: "wait", title: "Wait 10 minutes", detail: "time to stop it if it was a mistake" });
  deal.push({ id: "wave-1", type: "text", title: "Wave 1: the deal",
    detail: viaGhl ? "Tagged for your GHL workflow, which sends its own wording."
      : `${Array.isArray(da.dealTexts) && da.dealTexts.some((t) => String(t || "").trim()) ? "Your wording" : "The built-in wording"}, to up to ${n("autoBlastCount", 25)} VIP and Active buyers who buy in the area, match ${n("minMatchScore", 50)}+, one text every ${n("spreadSec", 60)} seconds, weekdays 8–5. Price, ARV and rehab are read again as each one sends.`,
    status: blast, texts: samples, edit: { field: "wave1" } });
  deal.push({ id: "reply", type: "branch", title: "A buyer replies",
    detail: `The bot answers, sends the package${da.blastLink === "on_reply" ? " link when they're interested" : ""}, and invites them to the walkthrough. Confirming a time is yours.`,
    status: stateOf(switches, "autosend:investor") });
  const fuDays = (followUp.steps || [3])[0];
  deal.push({ id: "wait-follow", type: "wait", title: `Wait ${plural(fuDays, "day")} after their last word`, detail: "only buyers who said something about the deal" });
  deal.push({ id: "follow", type: "text", title: "One follow-up about the deal",
    detail: "Written by the bot: picks up where they left off, never names a price. The only follow-up a buyer gets about a house.",
    status: stateOf(switches, "ladder:deal_followup"), day: fuDays, edit: { field: "dealFollowUp" } });
  for (let w = 2; w <= maxWaves; w++) {
    deal.push({ id: `wait-wave-${w}`, type: "wait", title: `Wait ${n("secondWaveHours", 48)} hours`, detail: "after the wave before, at the next morning run" });
    deal.push({ id: `wave-${w}`, type: "text", title: `Wave ${w}: the deal`,
      detail: `The same text as wave 1, to up to ${n("secondWaveCount", 25)} more buyers, any tier, match ${n("secondWaveMinScore", 35)}+, who haven't had it. Stops when a buyer commits or you stop the deal.`,
      status: auto ? blast : "off", edit: { field: "waveN" } });
  }
  deal.push({ id: "walkthrough", type: "text", title: "Walkthrough reminder and follow-up",
    detail: "Written by the bot to buyers who said they're coming: the afternoon before, then how it looked, 2–48 hours after.",
    status: ownState(showings.remindDayBefore || showings.followUpAfter, showings.autoSend, switches) });

  const between = [{ id: "pulse", type: "loop", title: `Check in every ${pulse.everyDays} days`,
    detail: `Between deals, up to ${pulse.dailyCap} a day at ${pulse.hour > 12 ? `${pulse.hour - 12}pm` : `${pulse.hour}am`}: buyers who bought from us first, then ones who never answered a deal. Written by the bot: who we are and one question about what they're buying, never a price or a link.`,
    status: ownState(pulse.enabled, pulse.autoSend, switches), voice: pulse.voice, edit: { field: "pulse" } }];

  const tb = da.touchBudget || {};
  const note = tb.enabled === false ? "" : `At most ${plural(Number(tb.quietPerWeek ?? 1), "text")} a week to a buyer who never wrote back, ${Number(tb.talkingPerWeek ?? 2)} to one we're talking to. Two deals waiting go in one text.`;
  return { deal, between, note };
}
