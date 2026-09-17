// partner-answer.js — a question the bot couldn't answer, answered once.
//
// 2026-09-17: three of Today's "we owe them an answer" rows were the bot
// saying "let me check with my partner" about things only Matt knows — the
// inspection window, how we handle referrals, when a full PSA goes out. The
// row offered Dismiss. The agent never got the answer, and the next agent to
// ask got the same deflection.
//
// Now the row is the question with a box (shared/pipeline.js). What Matt
// types is:
//   1. drafted to that agent in the bot's voice (the `partner_answer`
//      outbound kind). It lands in the outbox as an ordinary draft: it is not
//      on the auto-send grid, so his words never leave without his Send.
//   2. kept as a standing answer (`conversationAi.answers`), which the prompt
//      gives the bot as a fact, so the next agent who asks is answered.
//   3. what keeps the promise, so the row leaves Today.
//
// No names, numbers or message text are logged here; ids only.

import crypto from "node:crypto";
import { conversationConfig, saveConversationConfig, startProactive } from "./reply-agent.js";
import { settlePromise } from "./promise-sweep.js";
import { recordEvent } from "./contact-record.js";
import { hasContactDetails } from "./shared/coach.js";

const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const same = (a, b) => clean(a, 600).toLowerCase() === clean(b, 600).toLowerCase();

/**
 * answerPartnerQuestion({ client, locationId, store, contactId, draftId, address,
 *                         question, answer, saveAsFact, party, sendsEnabled, deps, now })
 *   → { started, skipped, jobId, savedAnswerId, notSaved }
 */
export async function answerPartnerQuestion({
  client = null, locationId, store, contactId, draftId = null, address = "", question = "", answer = "",
  saveAsFact = true, party = "agent", sendsEnabled = false, deps = {}, now = Date.now(),
}) {
  const who = clean(contactId, 64);
  const text = clean(answer, 600);
  if (!who) throw Object.assign(new Error("contactId is required"), { http: 400 });
  if (!text) throw Object.assign(new Error("type the answer first"), { http: 400 });
  const asked = clean(question, 300);

  const saved = (await store.getOfferSettings(locationId)) || {};
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;
  const r = await start({
    client, locationId, saved, store, contactId: who, kind: "partner_answer", offer: null,
    subject: { address: clean(address, 200), question: asked, answer: text }, sendsEnabled, deps,
  });
  // Nothing was drafted, so nothing was answered: the row stays, the answer
  // is not kept, and the box says why.
  if (r?.skipped) return { started: false, skipped: r.skipped, jobId: null, savedAnswerId: null, notSaved: "" };

  let savedAnswerId = null, notSaved = "";
  if (saveAsFact) {
    if (hasContactDetails(text)) {
      notSaved = "it carries a phone number, an email or a street address, so it went to them but isn't kept for next time";
    } else {
      const config = conversationConfig(saved);
      const existing = (config.answers || []).find((a) => same(a.answer, text) && same(a.question, asked));
      if (existing) savedAnswerId = existing.id;
      else {
        savedAnswerId = `ans-${crypto.randomBytes(5).toString("hex")}`;
        await saveConversationConfig(store, locationId, {
          ...config,
          answers: [...(config.answers || []), { id: savedAnswerId, party: party === "investor" ? "investor" : "agent", question: asked, answer: text, at: new Date(now).toISOString(), draftId: clean(draftId, 64) }],
        });
      }
    }
  }

  await settlePromise({ store, locationId, contactId: who, address: clean(address, 200), by: "answered", now });
  await recordEvent({
    store, locationId, contactId: who, party: party === "investor" ? "investor" : "agent", type: "partner_answered",
    at: new Date(now).toISOString(), address: clean(address, 200), source: "operator", ref: clean(draftId, 64) || null,
    dedupeKey: `partner_answered:${who}:${clean(draftId, 64) || new Date(now).toISOString()}`,
    data: { savedAnswerId, jobId: r?.job?.id || null },
  }).catch(() => {});
  return { started: true, skipped: null, jobId: r?.job?.id || null, savedAnswerId, notSaved };
}

/** forgetAnswer({ store, locationId, id }) → { removed } — the box's Undo, and the playbook page's delete. */
export async function forgetAnswer({ store, locationId, id }) {
  const saved = (await store.getOfferSettings(locationId)) || {};
  const config = conversationConfig(saved);
  const next = (config.answers || []).filter((a) => a.id !== String(id || ""));
  if (next.length === (config.answers || []).length) return { removed: false };
  await saveConversationConfig(store, locationId, { ...config, answers: next });
  return { removed: true };
}
