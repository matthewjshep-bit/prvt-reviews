// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// digest.js — the day's loose ends, in one read.
//
// The first full day of autonomy (2026-09-14) sent 63 texts on its own and
// left the important ones scattered: a seller who accepted our number, four
// counters, promises of "a number today" nobody kept, a dozen held underwrites,
// nineteen threads where the agent spoke last. Each lived in a different tab.
// This is the evening read: the few things that decide whether a deal happens,
// grouped, newest first.
//
// Pure. Rows in, sections out; `now` is injected.

export const DIGEST_SECTIONS = [
  { key: "accepted",       label: "Seller said yes" },
  { key: "close_counters", label: "Counters within 15% of our number" },
  { key: "owed",           label: "Numbers we promised and still owe" },
  { key: "unanswered",     label: "Texts nobody answered" },
  { key: "held",           label: "Underwrites that held" },
  { key: "floated",        label: "Numbers we floated" },
];

export const CLOSE_COUNTER_PCT = 0.15;
// Answering these is not the point of the digest.
const QUIET_INTENTS = new Set(["opt_out", "small_talk", "media"]);
const NUMBER_KINDS = new Set(["realm_check", "take_check", "price_drop"]);

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const k = (n) => `${Math.round(Number(n) / 1000)}k`;
const clip = (s, n = 120) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * buildDigest({ drafts, events, offers, now, hours })
 *   → { generatedAt, windowHours, sections: [{ key, label, items }], counts }
 *
 *   drafts  reply drafts created in the window (any status)
 *   events  promise_owed / promise_kept rows in the window
 *   offers  lean offer rows
 */
export function buildDigest({ drafts = [], events = [], offers = [], now = Date.now(), hours = 24 } = {}) {
  const from = now - hours * 3600000;
  const inWin = (v) => { const t = ms(v); return t != null && t >= from && t <= now; };
  const items = Object.fromEntries(DIGEST_SECTIONS.map((s) => [s.key, []]));
  const names = new Map();
  for (const d of drafts) if (d?.contactId && d.contactName) names.set(d.contactId, d.contactName);
  for (const o of offers) if (o?.contactId && o.contactName && !names.has(o.contactId)) names.set(o.contactId, o.contactName);
  const who = (id) => names.get(id) || "";

  // Newest draft per contact, ignoring rows a later draft replaced.
  const live = drafts.filter((d) => d && d.status !== "superseded" && inWin(d.createdAt))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const sentAfter = (contactId, at) => drafts.some((d) => d?.contactId === contactId && d.status === "sent" && String(d.sentAt || d.updatedAt || "") > String(at));

  /* --- the seller said yes --- */
  const accepted = new Set();
  for (const d of live) {
    if (d.intent !== "acceptance" || accepted.has(d.contactId)) continue;
    accepted.add(d.contactId);
    items.accepted.push({ contactId: d.contactId, contactName: d.contactName || who(d.contactId), address: d.propertyAddress || "", at: d.createdAt, detail: clip(d.inbound) });
  }

  /* --- counters close to our number --- */
  for (const o of offers) {
    if (!o?.id || o.deal) continue;
    const row = (o.statusHistory || []).filter((h) => h?.status === "countered" && Number(h.amount) > 0 && inWin(h.ts)).at(-1);
    const ours = Math.round(Number(o.cashAmount) || 0);
    if (!row || !(ours > 0)) continue;
    const theirs = Math.round(Number(row.amount));
    const gap = (theirs - ours) / ours;
    if (gap > CLOSE_COUNTER_PCT) continue;
    items.close_counters.push({ contactId: o.contactId, contactName: o.contactName || who(o.contactId), address: o.address || "", offerId: o.id, at: row.ts,
      detail: `their ${k(theirs)} vs our ${k(ours)}${gap > 0 ? ` (${Math.round(gap * 100)}% apart)` : ""}` });
  }

  /* --- promises still owed --- */
  for (const e of events) {
    if (e?.type !== "promise_owed" || !e.contactId || !inWin(e.at)) continue;
    if (events.some((x) => x?.type === "promise_kept" && x.contactId === e.contactId && String(x.at) >= String(e.at))) continue;
    items.owed.push({ contactId: e.contactId, contactName: who(e.contactId), address: e.address || "", at: e.at,
      detail: [e.data?.what === "number" ? "a number" : "an answer", e.data?.heldReason ? `underwrite held: ${clip(e.data.heldReason, 60)}` : ""].filter(Boolean).join(" · ") });
  }

  /* --- texts nobody answered --- */
  const seen = new Set();
  for (const d of live) {
    if (!d.inbound || seen.has(d.contactId)) continue;
    seen.add(d.contactId);
    if (["sent", "scheduled"].includes(d.status) || QUIET_INTENTS.has(d.intent)) continue;
    if (sentAfter(d.contactId, d.createdAt)) continue;
    items.unanswered.push({ contactId: d.contactId, contactName: d.contactName || who(d.contactId), address: d.propertyAddress || "", at: d.createdAt,
      detail: `${String(d.intent || "text").replace(/_/g, " ")}: ${clip(d.inbound, 90)}` });
  }

  /* --- underwrites that held --- */
  for (const o of offers) {
    const uw = o?.autoUnderwrite;
    if (!uw || uw.passed || o.status !== "draft" || !inWin(uw.finishedAt)) continue;
    items.held.push({ contactId: o.contactId, contactName: o.contactName || who(o.contactId), address: o.address || "", offerId: o.id, at: uw.finishedAt,
      detail: clip(String((uw.held || [])[0] || "").split(" — ")[0], 90) });
  }

  /* --- numbers we floated --- */
  for (const d of drafts) {
    if (d?.status !== "sent" || !inWin(d.sentAt || d.updatedAt)) continue;
    const kind = d.outbound?.kind || d.intent;
    if (!NUMBER_KINDS.has(kind)) continue;
    items.floated.push({ contactId: d.contactId, contactName: d.contactName || who(d.contactId), address: d.propertyAddress || d.outbound?.address || "", at: d.sentAt || d.updatedAt,
      detail: `${kind.replace(/_/g, " ")}${d.outbound?.amount ? ` · ${k(d.outbound.amount)}` : ""}` });
  }

  const newestFirst = (a, b) => String(b.at || "").localeCompare(String(a.at || ""));
  const sections = DIGEST_SECTIONS.map((s) => ({ ...s, items: items[s.key].sort(newestFirst) }));
  return {
    generatedAt: new Date(now).toISOString(),
    windowHours: hours,
    sections,
    counts: Object.fromEntries(sections.map((s) => [s.key, s.items.length])),
  };
}
