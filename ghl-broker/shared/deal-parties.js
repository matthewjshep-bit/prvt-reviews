// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// deal-parties.js — who else is on a deal, besides us and the buyers we pitch.
//
// A deal under contract has a title company, the seller's agent, sometimes a
// buyer's agent, the assignee (the end buyer) and often their lender. Matt,
// 2026-09-29: they belong on the deal, picked from GHL or typed in, so the
// closing checklist can say who owes what and the modal can call them.
//
// Only what the operator set is stored (`offer.deal.parties`). The rest is
// read off what the app already knows, with its source said, so a default
// never pretends to be a decision:
//   sellerAgent ← the offer's contact (the listing agent we wrote to)
//   assignee    ← the buyer marked committed on the deal
//   title       ← the offer's PSA fields, else the PSA defaults in Settings
// The lender is not defaulted: Settings' PSA lender is the one on OUR offer,
// and on an assignment the lender that matters is the assignee's.

export const PARTY_ROLES = ["title", "sellerAgent", "buyerAgent", "lender", "assignee"];
export const PARTY_LABEL = {
  title: "Title / escrow",
  sellerAgent: "Seller's agent",
  buyerAgent: "Buyer's agent",
  lender: "Lender",
  assignee: "Assignee",
};
// Who owns a checklist item: a party, or us.
export const OWNER_KEYS = ["us", ...PARTY_ROLES];
export const OWNER_LABEL = { us: "Us", ...PARTY_LABEL };

const FIELDS = ["contactId", "name", "company", "phone", "email", "note"];
const MAX = { contactId: 64, name: 120, company: 120, phone: 40, email: 160, note: 300 };

/** normalizeParty(raw) → { contactId, name, company, phone, email, note } | null when empty. */
export function normalizeParty(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const f of FIELDS) out[f] = String(raw[f] ?? "").trim().slice(0, MAX[f]);
  return FIELDS.some((f) => out[f]) ? out : null;
}

/** normalizeParties(raw) → { role: party } with only the roles that hold something. */
export function normalizeParties(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const role of PARTY_ROLES) {
    const p = normalizeParty(src[role]);
    if (p) out[role] = p;
  }
  return out;
}

/**
 * mergeParties(current, edit) → parties
 *
 * An edit names only the roles it changes. A role set to null (or to an
 * empty party) is cleared, so the default shows through again.
 */
export function mergeParties(current, edit = {}) {
  const next = { ...normalizeParties(current) };
  for (const role of PARTY_ROLES) {
    if (!(role in (edit || {}))) continue;
    const p = normalizeParty(edit[role]);
    if (p) next[role] = p; else delete next[role];
  }
  return next;
}

/**
 * resolveParties(offer, settings) → { role: { ...party, source, stored } | null }
 *
 * `source`: "deal" (set on the deal), "offer", "committed buyer",
 * "PSA settings", "the offer's PSA". `stored` says whether clearing it
 * would change anything.
 */
export function resolveParties(offer = {}, settings = {}) {
  const stored = normalizeParties(offer?.deal?.parties);
  const out = {};
  for (const role of PARTY_ROLES) out[role] = stored[role] ? { ...stored[role], source: "deal", stored: true } : null;

  if (!out.sellerAgent && (offer.contactId || offer.contactName)) {
    out.sellerAgent = { ...blank(), contactId: offer.contactId || "", name: offer.contactName || "", source: "offer", stored: false };
  }
  if (!out.assignee) {
    const c = (offer?.deal?.investors || []).find((i) => i?.status === "committed");
    if (c) out.assignee = { ...blank(), contactId: c.contactId || "", name: c.name || "", source: "committed buyer", stored: false };
  }
  if (!out.title) {
    const own = offer?.psa?.fields || {};
    const dflt = settings?.psa || {};
    const pick = (k) => String(own[k] || dflt[k] || "").trim();
    const company = pick("titleCompany");
    if (company || pick("titleOfficer")) {
      out.title = { ...blank(), company, name: pick("titleOfficer"), phone: pick("titlePhone"),
        source: own.titleCompany || own.titleOfficer ? "the offer's PSA" : "PSA settings", stored: false };
    }
  }
  return out;
}

const blank = () => Object.fromEntries(FIELDS.map((f) => [f, ""]));

/** partyName(party) → the line a chip shows: "Jane Doe (Ticor)", "Ticor", "". */
export function partyName(p) {
  if (!p) return "";
  const name = String(p.name || "").trim();
  const company = String(p.company || "").trim();
  return name && company ? `${name} (${company})` : name || company;
}
