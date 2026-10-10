// contact-card.js — the card's own text, right after a reply that earned it
// (shared/contact-card.js decides when), and the public link that serves the
// .vcf to the phone.
//
// The card is an MMS attachment by URL: GHL hands the link to the carrier,
// which fetches the file. The headers are what keep it a contact rather than
// "text_1.vcf": text/vcard and a Content-Disposition with the file name.

import crypto from "node:crypto";
import express from "express";
import { sendSms } from "./ghl.js";
import { recordEvent } from "./contact-record.js";
import { normalizeContactCard, cardMoment, cardPath } from "./shared/contact-card.js";

export const defaultCardBaseUrl = () => String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

export const mintCardToken = () => crypto.randomBytes(16).toString("hex");

/**
 * followWithCard({ client, store, locationId, draft, body, auto, baseUrl, now })
 *   → { sent, why }
 *
 * Called once the reply itself has gone. Never throws: a card that didn't go
 * is a line in the log, not a failed send.
 */
export async function followWithCard({ client, store, locationId, draft, body, auto = false, baseUrl = defaultCardBaseUrl(), now = Date.now() }) {
  try {
    const saved = (await store.getOfferSettings?.(locationId).catch(() => null)) || {};
    const card = normalizeContactCard(saved.conversationAi?.contactCard);
    if (!card.enabled) return { sent: false, why: "off" };
    if (!baseUrl) return { sent: false, why: "no public address for the card" };
    const sentCards = (await store.listContactEvents?.(locationId, draft.contactId, { types: ["contact_card_sent"], limit: 20 }).catch(() => [])) || [];
    const m = cardMoment({ card, draft, body, sentCards, now });
    if (!m.send) return { sent: false, why: m.why };
    const result = await sendSms(client, { contactId: draft.contactId, message: m.text, attachments: [`${baseUrl}${cardPath(card.token)}`] });
    await recordEvent({
      store, locationId, contactId: draft.contactId, party: draft.party || "agent", type: "contact_card_sent", at: new Date(now).toISOString(),
      address: draft.propertyAddress || draft.outbound?.address || "", source: "conversation", ref: draft.id,
      dedupeKey: `contact_card_sent:${draft.id}`,
      data: { draftId: draft.id, why: m.why, auto: Boolean(auto), messageId: result?.messageId || result?.id || null },
    }).catch(() => {});
    return { sent: true, why: m.why };
  } catch (e) {
    console.error(`contact-card: the card after draft ${draft?.id} didn't go:`, e?.message);
    return { sent: false, why: `failed: ${e?.message}` };
  }
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// GET /card/:token — outside the location gate on purpose: the carrier
// fetching the attachment has no key. The token is the credential, and a
// card is something we hand out anyway. Served whether or not the sending
// is switched on, so a card can be tried before it goes to anybody.
export function createContactCardPublicRouter({ store, locations = () => [] }) {
  const router = express.Router();
  router.get("/:token", async (req, res) => {
    const token = String(req.params.token || "").replace(/\.vcf$/i, "");
    if (!/^[a-f0-9]{24,64}$/.test(token)) return res.sendStatus(404);
    for (const loc of locations()) {
      const saved = await store.getOfferSettings(loc).catch(() => null);
      const card = normalizeContactCard(saved?.conversationAi?.contactCard);
      if (!card.vcard || !card.token || !sameToken(card.token, token)) continue;
      res.set("Content-Type", "text/vcard; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="${card.fileName}"`);
      res.set("Cache-Control", "public, max-age=300");
      return res.send(`${card.vcard.replace(/\r?\n/g, "\r\n")}\r\n`);
    }
    return res.sendStatus(404);
  });
  return router;
}
