// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// gatekeeper.js — the people who see a house before anyone lists it, other
// than listing agents: the attorney for an estate's personal representative
// (read off the probate Notice to Creditors), and the title and escrow
// officers we close with (Matt, 2026-10-26). Same playbook as the agent
// line — a public feed names them, one specific house opens the door, and
// the ask is the next one — sequenced on its own clock, apart from agents.
//
// Pure: identity, the hook a notice gives us, the ranking, the settings.

export const GATEKEEPER_KINDS = ["probate_attorney", "title", "escrow"];
export const GATEKEEPER_KIND_LABEL = { probate_attorney: "Probate attorney", title: "Title", escrow: "Escrow" };
export const GATEKEEPER_STATUSES = ["new", "skipped", "imported", "do_not_contact"];
export const HOOK_KINDS = ["estate", "closing", "file"];
// A hook older than this no longer counts toward an attorney's rank: the
// house is likely listed or sold by now.
export const RECENT_DAYS = 90;
const DAY_MS = 86400000;

const slug = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

export function splitName(name) {
  const parts = clean(name).replace(/,?\s+(?:Jr|Sr|II|III|IV)\.?$/i, "").split(" ").filter(Boolean);
  // "Paul Q. Counsel" → Paul / Counsel; a middle initial isn't a last name.
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return { firstName: parts[0] || "", lastName: last };
}

/**
 * gatekeeperKey({ kind, barNo, email, phone, name, firm }) → "wsba:40123" | "e:…" | "p:…" | "n:…|…"
 *
 * A lawyer's bar number is who they are, wherever they practise; else the
 * same email-then-phone-then-name order the agent line uses.
 */
export function gatekeeperKey({ kind = "", barNo = "", email = "", phone = "", name = "", firm = "" } = {}) {
  const bar = String(barNo || "").replace(/\D/g, "");
  if (kind === "probate_attorney" && bar) return `wsba:${bar}`;
  const e = String(email || "").trim().toLowerCase();
  if (e && /@/.test(e)) return `e:${e}`;
  const p = digits(phone);
  if (p.length === 10) return `p:${p}`;
  const n = slug(name);
  return n ? `n:${n}|${slug(firm)}` : "";
}

export const hookKeyForNotice = (n) => (n?.caseNo ? `probate:${slug(n.county)}:${n.caseNo.replace(/\s+/g, "-").toLowerCase()}` : "");

/**
 * fromNotice(notice) → { gatekeeper, hook } | null
 *
 * One parsed Notice to Creditors (shared/probate-notice.js) as the attorney
 * it names and the estate that opens the door. A personal representative
 * with no attorney (proSe) has no gatekeeper — that's a seller, not ours.
 */
export function fromNotice(n) {
  if (!n || n.proSe || !n.attorney) return null;
  const a = n.attorney;
  const key = gatekeeperKey({ kind: "probate_attorney", ...a });
  const hookKey = hookKeyForNotice(n);
  if (!key || !hookKey) return null;
  return {
    gatekeeper: {
      gkKey: key, kind: "probate_attorney",
      name: a.name || "", ...splitName(a.name), firm: a.firm || "", barNo: a.barNo || "",
      phone: digits(a.phone), email: String(a.email || "").toLowerCase(), office: a.address || null,
      counties: n.county ? [n.county] : [],
    },
    hook: {
      hookKey, gkKey: key, kind: "estate",
      county: n.county || "", caseNo: n.caseNo, decedent: n.decedent || "", pr: n.pr || "",
      firstPublished: n.firstPublished || "", filed: n.filed || "", nonprobate: n.nonprobate === true,
      house: null,
    },
  };
}

/** Merge a fresh read into what we already hold: blanks are filled, nothing is taken away. */
export function mergeGatekeeperDoc(prev = {}, next = {}) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (k === "counties") out.counties = [...new Set([...(prev.counties || []), ...(v || [])])];
    else if (v != null && v !== "" && (out[k] == null || out[k] === "")) out[k] = v;
  }
  return out;
}

const hookDay = (h) => h?.firstPublished || h?.closedAt || String(h?.firstSeen || "").slice(0, 10);

/**
 * rankGatekeepers(gatekeepers, hooks, { now }) → [{ ...gatekeeper, rank: { score, recent, withHouse, lastAt, why } }]
 *
 * The fixer score's twin. An attorney with three estates this quarter, two
 * of them with a house, is the one to call first; one estate a year ago is
 * not. Title and escrow rank by the closings we've shared, then recency.
 */
export function rankGatekeepers(gatekeepers = [], hooks = [], { now = Date.now() } = {}) {
  const byKey = new Map();
  for (const h of hooks) {
    if (!h?.gkKey) continue;
    if (!byKey.has(h.gkKey)) byKey.set(h.gkKey, []);
    byKey.get(h.gkKey).push(h);
  }
  const since = new Date(now - RECENT_DAYS * DAY_MS).toISOString().slice(0, 10);
  return gatekeepers.map((g) => {
    const mine = byKey.get(g.gkKey) || [];
    const recent = mine.filter((h) => (hookDay(h) || "") >= since);
    const withHouse = recent.filter((h) => h.house?.address).length;
    const lastAt = mine.map(hookDay).filter(Boolean).sort().pop() || "";
    const ageDays = lastAt ? Math.max(0, Math.round((now - Date.parse(lastAt)) / DAY_MS)) : RECENT_DAYS;
    const fresh = Math.max(0, RECENT_DAYS - ageDays) / RECENT_DAYS;   // 1 today → 0 at 90 days
    const closings = mine.filter((h) => h.kind === "closing").length;
    const score = Math.round((withHouse * 30 + recent.length * 10 + closings * 15 + fresh * 10) * 10) / 10;
    const why = [];
    if (recent.length) why.push(`${recent.length} estate${recent.length === 1 ? "" : "s"} in ${RECENT_DAYS} days`);
    if (withHouse) why.push(`${withHouse} with a house`);
    if (closings) why.push(`${closings} closing${closings === 1 ? "" : "s"} with us`);
    return { ...g, rank: { score, recent: recent.length, withHouse, closings, lastAt, why: why.join(" · ") } };
  }).sort((a, b) => b.rank.score - a.rank.score || String(b.rank.lastAt).localeCompare(String(a.rank.lastAt)));
}

/** The one house to open with: the newest estate with a house, else the newest estate. */
export function bestHook(hooks = []) {
  const sorted = [...hooks].sort((a, b) => String(hookDay(b)).localeCompare(String(hookDay(a))));
  return sorted.find((h) => h.house?.address) || sorted[0] || null;
}

/** "Estate of Harold Example · 1234 Elm St" — the line a row or a draft opens with. */
export function hookLine(h) {
  if (!h) return "";
  if (h.kind === "estate") return [h.decedent ? `Estate of ${h.decedent}` : `Estate ${h.caseNo}`, h.house?.address ? String(h.house.address).split(",")[0] : ""].filter(Boolean).join(" · ");
  if (h.kind === "closing") return [`Closed together`, h.address ? String(h.address).split(",")[0] : ""].filter(Boolean).join(" · ");
  return clean(h.address || h.note || "");
}

export const GATEKEEPER_DEFAULTS = Object.freeze({
  enabled: false,
  dryRun: true,
  autoSend: false,                       // drafts wait for Matt
  counties: ["King", "Snohomish", "Pierce"],
  dailyNew: 10,
  textAfterDays: 1,
  callAfterDays: 2,
  checkInEveryDays: 30,
  kinds: { probate_attorney: true, title: true, escrow: true },
  // The daily alert email from the statewide notice site, read from Gmail by
  // its sender alone (nothing else in the inbox is looked at). Empty = off.
  noticeEmailFrom: "",
});

const int = (v, d, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** Settings → outreachAutopilot.gatekeepers. Everything new ships off. */
export function normalizeGatekeepers(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const D = GATEKEEPER_DEFAULTS;
  const counties = Array.isArray(r.counties)
    ? [...new Set(r.counties.map((c) => clean(String(c).replace(/,?\s*(?:WA|Washington)$/i, "").replace(/\s+County$/i, ""))).filter(Boolean))]
    : [...D.counties];
  const kinds = {};
  for (const k of GATEKEEPER_KINDS) kinds[k] = r.kinds && typeof r.kinds === "object" && k in r.kinds ? r.kinds[k] === true : D.kinds[k];
  const from = clean(r.noticeEmailFrom).toLowerCase();
  return {
    enabled: r.enabled === true,
    dryRun: r.dryRun !== false,
    autoSend: r.autoSend === true,
    counties,
    dailyNew: int(r.dailyNew, D.dailyNew, 0, 100),
    textAfterDays: int(r.textAfterDays, D.textAfterDays, 0, 14),
    callAfterDays: int(r.callAfterDays, D.callAfterDays, 0, 30),
    checkInEveryDays: int(r.checkInEveryDays, D.checkInEveryDays, 7, 120),
    kinds,
    noticeEmailFrom: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) ? from : "",
  };
}
