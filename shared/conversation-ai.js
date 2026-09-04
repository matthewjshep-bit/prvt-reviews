// conversation-ai.js — the Conversation AI's configuration: who the bot is,
// what it may say and do, and to whom. One plain object the console edits and
// the broker reads. Pure — no I/O — so the same normalizer runs on both ends
// and a saved blob is never trusted, only filled and checked.
//
// Two parties, two vocabularies. A listing agent texts us about an offer we
// made; a cash-buyer investor texts us about a deal we're selling. Different
// questions, different things that commit us, different numbers the bot may
// quote. So each party has its own intent list, playbook and "never on its
// own" set; what they share is the persona, the house rules, the examples and
// the machinery underneath.

export const PARTIES = ["agent", "investor"];
export const PARTY_LABEL = { agent: "Listing agent", investor: "Investor", unknown: "Unknown" };
export const CONFIDENCES = ["high", "medium", "low"];

// What the other person is doing, as far as the model can tell. Closed sets,
// so the gates and the rules can reason about them — an intent nobody listed
// comes back as "other" and holds.
export const INTENTS = {
  agent: [
    "question", "counter", "acceptance", "rejection", "wants_call", "scheduling",
    "proof_of_funds", "new_property", "status_check", "small_talk", "other",
  ],
  investor: [
    "question", "interested", "looking_for_deals", "price_pushback", "wants_to_buy",
    "wants_walkthrough", "passing", "wants_call", "buybox_update", "status_check",
    "small_talk", "other",
  ],
};

export const INTENT_LABEL = {
  agent: {
    question: "question", counter: "counter", acceptance: "wants to move forward", rejection: "passed",
    wants_call: "wants a call", scheduling: "scheduling", proof_of_funds: "proof of funds",
    new_property: "new property", status_check: "checking in", small_talk: "small talk", other: "other",
  },
  investor: {
    question: "question", interested: "wants details", looking_for_deals: "asking what we have",
    price_pushback: "pushing on price", wants_to_buy: "wants to buy", wants_walkthrough: "wants to walk it",
    passing: "passing", wants_call: "wants a call", buybox_update: "buy box update",
    status_check: "checking in", small_talk: "small talk", other: "other",
  },
};

// The definitions the model classifies against — and the tooltips the operator
// reads. One source for both, so what the page says an intent means is what
// the model was told it means.
export const INTENT_GLOSS = {
  agent: {
    question: "asks something answerable from the thread or the offer book",
    counter: "names a different number, or asks if we'd go higher",
    acceptance: "accepts, or says the seller wants to move forward",
    rejection: "passes — \"seller went another way\", \"too low\"",
    wants_call: "asks to talk, or for a callback",
    scheduling: "a showing, inspection, walkthrough, a time or a date",
    proof_of_funds: "asks for proof of funds, a bank letter, or who the buyer is",
    new_property: "brings up a house we haven't offered on",
    status_check: "\"did you get my email\", \"any update\", \"still interested?\"",
    small_talk: "thanks, ok, a thumbs up — nothing to answer",
    other: "anything else",
  },
  investor: {
    question: "asks something answerable from the thread or the deals in context",
    interested: "wants details, photos, numbers or the address on a deal we mentioned",
    looking_for_deals: "asks what we have, or whether we have anything in an area",
    price_pushback: "says the price is too high, or names a lower number",
    wants_to_buy: "wants to move forward — sign, send earnest money, lock it up",
    wants_walkthrough: "wants to see the property, or proposes a time to walk it",
    passing: "passes on a deal, with or without a reason",
    wants_call: "asks to talk, or for a callback",
    buybox_update: "tells us what they buy — areas, price range, types, rehab appetite",
    status_check: "\"any update\", \"is it still available\", \"did you get my text\"",
    small_talk: "thanks, ok, a thumbs up — nothing to answer",
    other: "anything else",
  },
};

// Never auto-sendable, whatever the page says. Each of these commits us to
// something — a number, a time, a document, a deal — and stays a person's
// call. The allowlist an operator can build is everything NOT here.
export const NEVER_AUTO = {
  agent: ["counter", "acceptance", "wants_call", "scheduling", "proof_of_funds", "new_property", "other"],
  investor: ["price_pushback", "wants_to_buy", "wants_walkthrough", "wants_call", "other"],
};
export const autoEligible = (party) =>
  (INTENTS[party] || []).filter((i) => !(NEVER_AUTO[party] || []).includes(i));

/* ---------- actions: what an intent may trigger in GHL, or here ---------- */

export const ACTION_TYPES = [
  "add_tags", "remove_tags", "set_field", "add_to_workflow",
  "link_deal_evaluating", "start_underwrite", "suggest_dataroom_invite",
];
export const ACTION_LABEL = {
  add_tags: "Add tags", remove_tags: "Remove tags", set_field: "Set a custom field",
  add_to_workflow: "Add to a GHL workflow", link_deal_evaluating: "Link them to the deal as evaluating",
  start_underwrite: "Start an auto-underwrite", suggest_dataroom_invite: "Suggest a dataroom invite",
};
// Actions that run on the broker rather than in GHL, and which party each
// makes sense for. An investor can't be underwritten; an agent isn't invited
// to a dataroom.
export const INTERNAL_ACTIONS = new Set(["link_deal_evaluating", "start_underwrite", "suggest_dataroom_invite"]);
export const INTERNAL_ACTIONS_FOR = {
  agent: ["start_underwrite"],
  investor: ["link_deal_evaluating", "suggest_dataroom_invite"],
};
// Never automatic: a dataroom link is a document going out, so it is always
// suggested and applied by a person.
export const ASK_ONLY_ACTIONS = new Set(["suggest_dataroom_invite"]);
export const actionAllowedFor = (party, type) =>
  ACTION_TYPES.includes(type) &&
  (!INTERNAL_ACTIONS.has(type) || (INTERNAL_ACTIONS_FOR[party] || []).includes(type));

export const RULE_MODES = ["auto", "ask"];
export const LENGTHS = ["short", "medium", "long"];
export const CHANNELS = ["sms", "email"];
// What a set_field value may interpolate. Anything else is left as typed.
export const TOKENS = ["intent", "propertyAddress", "summary", "date", "party", "contactName", "counterAmount"];

/* ---------- defaults ---------- */

const PLAYBOOK = () => ({
  instructions: "",
  mayCommit: "",
  mayNotCommit: "",
  autoSend: { enabled: false, intents: [] },
  intentRules: {},
});

export const CONVERSATION_AI_DEFAULTS = Object.freeze({
  version: 1,
  enabled: true,
  dailyCap: 60,
  persona: { name: "", role: "", voice: "", signOff: "", length: "short", useFirstName: true },
  rules: [],
  examples: [],
  routing: {
    agentTags: ["agent", "agent-*"],
    investorTags: ["investor", "investor-*", "on-deal"],
    priority: "agent",
    unknown: "hold",
    genericInstructions: "",
  },
  parties: { agent: PLAYBOOK(), investor: PLAYBOOK() },
  autoSend: {
    delayMinSec: 120,
    delayMaxSec: 240,
    quietHours: { start: "08:00", end: "20:00", timeZone: "America/Los_Angeles" },
    channels: ["sms"],
  },
});

/* ---------- coercion helpers ---------- */

const str = (v, max) => String(v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, max);
const bool = (v, def) => (v == null ? def : v === true || v === "true" || v === 1 || v === "1");
const int = (v, def, min, max) => {
  if (v == null || String(v).trim() === "") return def;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const oneOf = (v, allowed, def) => (allowed.includes(v) ? v : def);
// A list from an array or a comma/newline-separated string. Trimmed, emptied
// of blanks, deduped, capped.
const list = (v, { max = 40, each = 200, lower = false } = {}) => {
  const raw = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,\n]/);
  const out = [];
  for (const x of raw) {
    let s = str(x, each);
    if (lower) s = s.toLowerCase();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const hhmm = (v, def) => (HHMM_RE.test(String(v || "").trim()) ? String(v).trim() : def);

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
const slugKey = (v) => str(v, 60).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

function normalizeAction(a, party) {
  if (!a || typeof a !== "object") return null;
  const type = str(a.type, 40);
  if (!actionAllowedFor(party, type)) return null;
  switch (type) {
    case "add_tags":
    case "remove_tags": {
      const tags = list(a.tags, { max: 10, each: 80, lower: true });
      return tags.length ? { type, tags } : null;
    }
    case "set_field": {
      const key = slugKey(a.key);
      if (!FIELD_KEY_RE.test(key)) return null;
      return { type, key, value: str(a.value, 300) };
    }
    case "add_to_workflow": {
      const workflowId = str(a.workflowId, 80);
      if (!workflowId) return null;
      return { type, workflowId, workflowName: str(a.workflowName, 120) };
    }
    default:
      return { type };
  }
}

function normalizePlaybook(p, party, seed = {}) {
  const src = p && typeof p === "object" ? p : {};
  const eligible = autoEligible(party);
  const intentRules = {};
  const rulesSrc = src.intentRules && typeof src.intentRules === "object" ? src.intentRules : {};
  for (const intent of INTENTS[party]) {
    const r = rulesSrc[intent];
    if (!r || typeof r !== "object") continue;
    const actions = (Array.isArray(r.actions) ? r.actions : [])
      .map((a) => normalizeAction(a, party)).filter(Boolean).slice(0, 8);
    if (!actions.length) continue;
    // A document going out is never automatic, whatever the row says.
    const askOnly = actions.some((a) => ASK_ONLY_ACTIONS.has(a.type));
    intentRules[intent] = { mode: askOnly ? "ask" : oneOf(r.mode, RULE_MODES, "ask"), actions };
  }
  const auto = src.autoSend && typeof src.autoSend === "object" ? src.autoSend : {};
  return {
    instructions: str(src.instructions ?? seed.instructions, 4000),
    mayCommit: str(src.mayCommit, 1500),
    mayNotCommit: str(src.mayNotCommit, 1500),
    autoSend: {
      enabled: bool(auto.enabled, false),
      intents: list(auto.intents, { max: 20, each: 40 }).filter((i) => eligible.includes(i)),
    },
    intentRules,
  };
}

/**
 * normalizeConversationAi(doc, seed)
 *
 * Fill every key from the defaults, coerce every value to its type, drop what
 * the vocabulary doesn't know, and enforce the two rules that are not the
 * operator's to relax: NEVER_AUTO intents never reach an allowlist, and an
 * ask-only action forces its rule to "ask".
 *
 * `seed` — { instructions, dailyCap, signer } from the first-version reply
 * agent's settings — applies ONLY when there is no saved doc at all, so a
 * location that never opened the tab keeps the behaviour it had.
 *
 * Idempotent: normalize(normalize(x)) deep-equals normalize(x).
 */
export function normalizeConversationAi(doc, seed = {}) {
  const fresh = doc == null || typeof doc !== "object";
  const d = fresh ? {} : doc;
  const D = CONVERSATION_AI_DEFAULTS;
  const s = seed && typeof seed === "object" ? seed : {};
  const seedFor = fresh ? s : {};

  const persona = d.persona && typeof d.persona === "object" ? d.persona : {};
  const routing = d.routing && typeof d.routing === "object" ? d.routing : {};
  const auto = d.autoSend && typeof d.autoSend === "object" ? d.autoSend : {};
  const qh = auto.quietHours && typeof auto.quietHours === "object" ? auto.quietHours : {};
  const parties = d.parties && typeof d.parties === "object" ? d.parties : {};

  const delayMin = int(auto.delayMinSec, D.autoSend.delayMinSec, 0, 3600);
  const delayMax = Math.max(delayMin, int(auto.delayMaxSec, D.autoSend.delayMaxSec, 0, 3600));

  const examples = [];
  for (const [i, ex] of (Array.isArray(d.examples) ? d.examples : []).entries()) {
    if (!ex || typeof ex !== "object") continue;
    const theySaid = str(ex.theySaid, 600);
    const weSay = str(ex.weSay, 600);
    if (!theySaid && !weSay) continue;
    examples.push({
      id: str(ex.id, 40) || `ex-${i + 1}`,
      party: oneOf(ex.party, [...PARTIES, "any"], "any"),
      theySaid, weSay,
    });
    if (examples.length >= 30) break;
  }

  const agentTags = "agentTags" in routing ? list(routing.agentTags, { max: 30, each: 80, lower: true }) : [...D.routing.agentTags];
  const investorTags = "investorTags" in routing ? list(routing.investorTags, { max: 30, each: 80, lower: true }) : [...D.routing.investorTags];

  return {
    version: 1,
    enabled: bool(d.enabled, D.enabled),
    dailyCap: int(d.dailyCap ?? seedFor.dailyCap, D.dailyCap, 1, 1000),
    persona: {
      name: str(persona.name ?? seedFor.signer, 80),
      role: str(persona.role, 120),
      voice: str(persona.voice, 1500),
      signOff: str(persona.signOff, 80),
      length: oneOf(persona.length, LENGTHS, D.persona.length),
      useFirstName: bool(persona.useFirstName, D.persona.useFirstName),
    },
    rules: list(d.rules, { max: 40, each: 300 }),
    examples,
    routing: {
      agentTags,
      investorTags,
      priority: oneOf(routing.priority, PARTIES, D.routing.priority),
      unknown: oneOf(routing.unknown, ["hold", "generic"], D.routing.unknown),
      genericInstructions: str(routing.genericInstructions, 2000),
    },
    parties: {
      agent: normalizePlaybook(parties.agent, "agent", { instructions: seedFor.instructions }),
      investor: normalizePlaybook(parties.investor, "investor"),
    },
    autoSend: {
      delayMinSec: delayMin,
      delayMaxSec: delayMax,
      quietHours: {
        start: hhmm(qh.start, D.autoSend.quietHours.start),
        end: hhmm(qh.end, D.autoSend.quietHours.end),
        timeZone: isValidTimeZone(qh.timeZone) ? qh.timeZone : D.autoSend.quietHours.timeZone,
      },
      channels: Array.isArray(auto.channels)
        ? list(auto.channels, { max: 10, each: 10, lower: true }).filter((c) => CHANNELS.includes(c))
        : [...D.autoSend.channels],
    },
  };
}

/* ---------- tokens in a set_field value ---------- */

export function substituteTokens(template, draft = {}) {
  const values = {
    intent: draft.intent || "",
    propertyAddress: draft.propertyAddress || "",
    summary: draft.summary || "",
    date: new Date(draft.now || Date.now()).toISOString().slice(0, 10),
    party: draft.party || "",
    contactName: draft.contactName || "",
    counterAmount: draft.counterAmount ? String(draft.counterAmount) : "",
  };
  return String(template == null ? "" : template).replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (m, k) =>
    (k in values ? values[k] : m));
}

/* ---------- the graduation evidence ---------- */

// Per party × intent, what happened to the drafts. The two numbers that decide
// whether an intent is ready to send on its own are `autoSendable` (the gates
// would have let it) and `humanSentUnedited` (a person then sent it as
// written) — when those agree for a few weeks, the person was a formality.
const emptyCell = () => ({
  total: 0, autoSendable: 0, autoSent: 0, sent: 0, sentUnedited: 0, sentEdited: 0,
  humanSentUnedited: 0, dismissed: 0, held: 0, superseded: 0, pending: 0,
});

export function draftStats(rows = []) {
  const byParty = {};
  const totals = emptyCell();
  for (const r of rows) {
    if (!r) continue;
    const party = PARTIES.includes(r.party) ? r.party : r.party === "unknown" ? "unknown" : "agent";
    const intent = r.intent || "other";
    byParty[party] = byParty[party] || { total: 0, byIntent: {} };
    const cell = (byParty[party].byIntent[intent] = byParty[party].byIntent[intent] || emptyCell());
    byParty[party].total++;
    for (const c of [cell, totals]) {
      c.total++;
      if (r.autoSendable) c.autoSendable++;
      if (r.status === "sent") {
        c.sent++;
        if (r.autoSent) c.autoSent++;
        if (r.edited) c.sentEdited++;
        else {
          c.sentUnedited++;
          if (!r.autoSent && r.autoSendable) c.humanSentUnedited++;
        }
      }
      if (r.status === "dismissed") c.dismissed++;
      if (r.status === "superseded") c.superseded++;
      if (r.status === "draft" || r.status === "scheduled" || r.status === "sending") c.pending++;
      if (r.heldAt) c.held++;
    }
  }
  return { byParty, totals };
}
