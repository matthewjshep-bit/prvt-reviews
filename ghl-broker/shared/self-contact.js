// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// self-contact.js — the operator's own GHL contact is not work on Today.
//
// Matt, 2026-09-28: a test contact named "Matt Shepherd" (him, texting the
// line to try it) sat at the top of Today with a bot follow-up drafted to
// himself and two offers on the board. Rows about that contact are dropped.
//
// Matched on the name the app already knows is his: settings.company.signer
// and the Conversation AI persona name. Offers carry only a contact name, so
// name is the one key every row has. It takes a full name (first + last) to
// match — "Matt" alone would hide every other Matt — and the first names may
// be the short form of each other, so "Matthew Shepherd" on the letterhead
// matches "Matt Shepherd" in GHL. Whole contacts go: once one row names him,
// every row for that contactId does.
//
// Pure.

const words = (s) => String(s || "").toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter(Boolean);

/** selfNames({ company, persona }) → [[first, last], …] for every full name we sign as. */
export function selfNames({ company = null, persona = null } = {}) {
  const out = [];
  for (const n of [company?.signer, persona?.name]) {
    const w = words(n);
    if (w.length >= 2) out.push([w[0], w[w.length - 1]]);
  }
  return out;
}

const firstMatches = (a, b) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/** isSelfName(name, names) → true when the name is one of ours. */
export function isSelfName(name, names = []) {
  const w = words(name);
  if (w.length < 2) return false;
  const [first, last] = [w[0], w[w.length - 1]];
  return names.some(([f, l]) => l === last && firstMatches(f, first));
}

/** selfContactIds(rows, names) → Set of contactIds any row names as us. */
export function selfContactIds(rows = [], names = []) {
  const ids = new Set();
  if (!names.length) return ids;
  for (const r of rows || []) if (r?.contactId && isSelfName(r.contactName, names)) ids.add(r.contactId);
  return ids;
}

/** withoutSelf(rows, ids) → the rows whose contact isn't us. */
export function withoutSelf(rows = [], ids = new Set()) {
  return ids.size ? (rows || []).filter((r) => !ids.has(r?.contactId)) : rows || [];
}
