// conversation-prompt.js — what the model is told, built from the page.
//
// The first version had one hardcoded system prompt for listing agents. Now
// the prompt is assembled from the operator's persona, house rules and
// examples, plus the playbook for whichever party is texting — so "sound like
// me" is a textarea, not a redeploy, and an investor is answered by someone
// who knows they are an investor. Pure.

import { INTENTS, INTENT_GLOSS, PARTY_LABEL, CONFIDENCES } from "./shared/conversation-ai.js";

const LENGTH_RULE = {
  short: "One to three sentences.",
  medium: "Two to five sentences.",
  long: "As long as it needs to be, but never padded.",
};

const WHO = {
  agent:
    "The person texting you is the LISTING AGENT on a property you have made, or may make, a cash offer on. " +
    "They represent the seller. They care about a clean close, a serious buyer, and not wasting their time.",
  investor:
    "The person texting you is a cash-buyer INVESTOR on your list — someone who buys the deals you put under " +
    "contract. You are selling to them. They care about the numbers, the area, the condition, and whether the " +
    "deal is real.",
  unknown:
    "You do not know who the person texting you is — they carry none of the tags that mark an agent or an " +
    "investor. Be courteous and brief, find out what they need, and commit to nothing.",
};

const FACTS =
  "FACTS: every number, date, address and term you use must come from the CONTEXT you are given — the " +
  "thread, the records listed, or the operator's standing instructions. Never invent a price, a closing " +
  "timeline, an earnest money amount, a contingency, a proof-of-funds claim, or a company detail. If they ask " +
  "something the context does not answer, say you will check and get back to them today; do not guess.";

const COMMITMENTS = {
  agent:
    "COMMITMENTS: you may NOT accept a counter, raise or lower an offer, propose or confirm a showing or " +
    "inspection time, promise proof of funds, or agree to terms. When the agent asks for any of those, write a " +
    "holding reply that acknowledges it specifically and promises a same-day answer (\"Let me run that number " +
    "by my partner and get back to you this afternoon\"), and set needsHuman to true with the reason. A " +
    "rejection needs no counter-argument: thank them, ask them to keep us in mind for the next one, and stop.",
  investor:
    "COMMITMENTS: you may NOT lower a price, agree to terms, promise a deal to them, confirm a walkthrough time, " +
    "or send documents. When the investor wants to buy, walk the property, or pushes on price, write a holding " +
    "reply that acknowledges it specifically and promises a same-day answer (\"Let me confirm it's still open " +
    "and get you a time today\"), and set needsHuman to true with the reason. " +
    "PRICE: the only figure you may quote on a deal is the buyer price listed for it in the context. Never " +
    "state, hint at, or let them back into our purchase price, contract price, assignment fee, spread or " +
    "margin — if asked, say the price is the price and move on. Never name a deal that is not in the context.",
  unknown:
    "COMMITMENTS: you may not quote a number, promise anything, or agree to anything. Ask what they need and " +
    "set needsHuman to true so a person picks it up.",
};

const CLOSING =
  "If the newest message needs no reply at all (a thanks, an ok, a thumbs up), set intent to small_talk, " +
  "needsHuman to false, and return an empty reply. " +
  "summary is one line for the operator, in the third person, saying what they want and what the draft does " +
  "about it. propertyAddress is the property the message is about when one is identifiable, else empty. " +
  "counterAmount is a dollar figure THEY named in this message, in whole dollars, else 0.";

/**
 * buildSystemPrompt({ config, party, channel }) → string
 */
export function buildSystemPrompt({ config, party = "agent", channel = "sms" } = {}) {
  const persona = config?.persona || {};
  const playbook = config?.parties?.[party] || {};
  const who = persona.name ? persona.name : "a real-estate investor";
  const role = persona.role ? ` — ${persona.role}` : " (a cash buyer who makes offers on listed homes and sells the deals to other investors)";
  const medium = channel === "email" ? "email replies" : "text-message replies";
  const parts = [];

  parts.push(
    `You write ${medium} as ${who}${role}. You are answering in the first person, as that person. ` +
    `${WHO[party] || WHO.unknown} They are talking to a person, not a bot, and must never be told otherwise.`
  );

  const voice = [
    persona.voice ? `VOICE: ${persona.voice}` : "VOICE: short, plain, warm, professional. No salesy language.",
    LENGTH_RULE[persona.length] || LENGTH_RULE.short,
    channel === "email" ? "No subject line — just the body." : "No emojis, no exclamation marks, no bullet points.",
    persona.useFirstName ? "Use their first name once at most." : "Do not use their name.",
    persona.signOff ? `Sign off exactly as: ${persona.signOff}` : "No sign-off — a text from a person doesn't need one.",
  ];
  parts.push(voice.join(" "));

  parts.push(FACTS);
  parts.push(COMMITMENTS[party] || COMMITMENTS.unknown);
  if (playbook.mayCommit) parts.push(`YOU MAY, on your own: ${playbook.mayCommit}`);
  if (playbook.mayNotCommit) parts.push(`YOU MAY NOT, ever: ${playbook.mayNotCommit}`);
  if (config?.rules?.length) parts.push(`HOUSE RULES — never break these:\n${config.rules.map((r) => `- ${r}`).join("\n")}`);

  const intents = INTENTS[party] || INTENTS.agent;
  const gloss = INTENT_GLOSS[party] || INTENT_GLOSS.agent;
  parts.push(
    `INTENT: classify the newest message as exactly one of:\n` +
    intents.map((i) => `- ${i}: ${gloss[i] || i}`).join("\n") +
    `\nconfidence is ${CONFIDENCES.join("/")} — how sure you are of the intent AND that the reply is right.`
  );

  const examples = (config?.examples || []).filter((e) => e.party === "any" || e.party === party).slice(0, 12);
  if (examples.length) {
    parts.push(
      "EXAMPLES OF OUR VOICE (match the tone, not the facts):\n" +
      examples.map((e) => `They said: "${e.theySaid}"\nWe say: "${e.weSay}"`).join("\n\n")
    );
  }

  parts.push(CLOSING);
  return parts.join("\n\n");
}

/**
 * buildUserContext({ party, contact, signer, instructions, context, underwriting, transcript, message })
 *
 * The per-message block: who they are, what we know, the thread, the message.
 * `context.text` is the party-specific record block from conversation-context.js.
 */
export function buildUserContext({
  party = "agent", contact = {}, signer = "", instructions = "", context = { text: "" },
  underwriting = [], transcript = "", message = "",
} = {}) {
  const label = party === "investor" ? "INVESTOR" : party === "agent" ? "AGENT" : "CONTACT";
  const them = party === "investor" ? "the investor" : party === "agent" ? "the agent" : "them";
  return [
    `${label}: ${contact.name || "unknown name"}${contact.tags?.length ? ` (tags: ${contact.tags.slice(0, 8).join(", ")})` : ""}`,
    signer ? `YOU ARE: ${signer}` : "",
    instructions ? `OPERATOR'S STANDING INSTRUCTIONS (follow these):\n${String(instructions).slice(0, 4000)}` : "",
    context?.text || (party === "investor" ? "DEALS: none on record for this investor." : party === "agent" ? "OUR OFFERS TO THIS AGENT: none on record." : ""),
    underwriting.length
      ? `IN PROGRESS RIGHT NOW: we are working up numbers on ${underwriting.join("; ")} — you may say an offer is coming shortly, without a number.`
      : "",
    transcript
      ? `THE THREAD SO FAR (US = our team, THEM = ${them}):\n${String(transcript).slice(0, 14000)}`
      : "THE THREAD SO FAR: (no earlier messages available)",
    `NEWEST INBOUND MESSAGE FROM ${label === "CONTACT" ? "THEM" : `THE ${label}`} (this is what you are replying to):\n"${String(message || "").slice(0, 2000)}"`,
    "Write the reply.",
  ].filter(Boolean).join("\n\n");
}

export function schemaFor(party = "agent") {
  return {
    type: "object",
    additionalProperties: false,
    required: ["intent", "confidence", "reply", "needsHuman", "humanReason", "summary", "propertyAddress", "counterAmount"],
    properties: {
      intent: { type: "string", enum: INTENTS[party] || INTENTS.agent },
      confidence: { type: "string", enum: CONFIDENCES, description: "How sure you are of the intent AND that the reply is right" },
      reply: { type: "string", description: "The reply text, or empty when nothing should be sent" },
      needsHuman: { type: "boolean", description: "True when the message asks for anything that commits us" },
      humanReason: { type: "string", description: "Why a person must look, or empty" },
      summary: { type: "string", description: "One line for the operator" },
      propertyAddress: { type: "string", description: "The property this message is about, if one is identifiable; else empty" },
      counterAmount: { type: "integer", description: "A dollar figure they named, in whole dollars; 0 if none" },
    },
  };
}

export { PARTY_LABEL };
