// deal-checklist.js — everything that has to happen between "under contract"
// and "closed", who owes it, and by when.
//
// Matt, 2026-09-29: a stage gate. Each deal stage has the things that must be
// done before the deal moves on; each thing has an owner (us or one of the
// deal's parties, shared/deal-parties.js) and a due date read off the
// contract's own dates. The list starts from a standard WA assignment
// checklist and is the deal's own from then on — tick, re-date, reassign,
// delete, add.
//
// The gate is soft: moving a deal on with items open asks first, never
// blocks. Deals are messy and the operator knows things the list doesn't.
//
// Pure. `offer.deal.checklist` is `{ items: [...] }`; a deal with none reads
// the template, and the template is written down the first time anything
// changes (or at promote), so an edit to the template later never rewrites a
// deal already in flight.

import { OWNER_KEYS } from "./deal-parties.js";

export const GATES = ["under_contract", "buyer_found", "assigned"];
export const GATE_LABEL = { under_contract: "Under contract", buyer_found: "Buyer found", assigned: "Assigned", closed: "Closed" };
// Where a deal goes once a gate is done — the stepper's last node is Closed.
export const NEXT_STAGE = { under_contract: "buyer_found", buyer_found: "assigned", assigned: "closed" };
export const RULE_FROM = ["contract", "inspection", "closing", "stage"];
export const DUE_SOON_DAYS = 2;
const TZ = "America/Los_Angeles";
const DAY_MS = 86400000;

// `auto`: "walkthrough" is done once a buyer is marked as having walked it
// (shared/showing.js); `doc` is done once a document of that kind is on the
// deal. Both can also be ticked by hand.
export const CHECKLIST_TEMPLATE = [
  { id: "psa_signed", gate: "under_contract", label: "Purchase & sale signed by both sides", owner: "us", rule: { from: "contract", days: 0 }, doc: "Purchase & sale" },
  { id: "open_escrow", gate: "under_contract", label: "Open escrow: send the PSA to title", owner: "us", rule: { from: "contract", days: 1 } },
  { id: "earnest_money", gate: "under_contract", label: "Earnest money to title", owner: "us", rule: { from: "contract", days: 3 } },
  { id: "prelim_title", gate: "under_contract", label: "Preliminary title report back and reviewed", owner: "title", rule: { from: "contract", days: 7 } },
  { id: "inspection", gate: "under_contract", label: "Inspection / feasibility done or waived", owner: "us", rule: { from: "inspection", days: 0 } },
  { id: "walkthrough", gate: "under_contract", label: "Buyer walkthrough", owner: "us", rule: null, auto: "walkthrough" },
  { id: "assignment_signed", gate: "buyer_found", label: "Assignment signed", owner: "assignee", rule: { from: "stage", days: 2 }, doc: "Assignment" },
  { id: "assignee_deposit", gate: "buyer_found", label: "Assignee's deposit to title", owner: "assignee", rule: { from: "stage", days: 3 } },
  { id: "assignee_funds", gate: "buyer_found", label: "Proof of funds or lender approval", owner: "assignee", rule: { from: "stage", days: 3 } },
  { id: "assignment_to_title", gate: "buyer_found", label: "Assignment and assignee details to title", owner: "us", rule: { from: "stage", days: 3 } },
  { id: "lender_clear", gate: "assigned", label: "Lender clear to close (if financed)", owner: "lender", rule: { from: "closing", days: -3 } },
  { id: "seller_signs", gate: "assigned", label: "Seller signs closing docs", owner: "sellerAgent", rule: { from: "closing", days: -2 } },
  { id: "assignee_signs", gate: "assigned", label: "Assignee signs and funds", owner: "assignee", rule: { from: "closing", days: -1 } },
  { id: "recorded", gate: "assigned", label: "Recorded, assignment fee received", owner: "title", rule: { from: "closing", days: 0 } },
];

const MAX_ITEMS = 60;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const str = (v, max) => String(v ?? "").trim().slice(0, max);

function normalizeRule(r) {
  if (!r || typeof r !== "object" || !RULE_FROM.includes(r.from)) return null;
  const days = Math.round(Number(r.days) || 0);
  return { from: r.from, days: Math.max(-90, Math.min(365, days)) };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = str(raw.id, 40);
  const label = str(raw.label, 160);
  if (!id || !label || !GATES.includes(raw.gate)) return null;
  return {
    id, gate: raw.gate, label,
    owner: OWNER_KEYS.includes(raw.owner) ? raw.owner : "us",
    rule: normalizeRule(raw.rule),
    due: isYmd(raw.due) ? raw.due : "",
    done: Boolean(raw.done),
    doneAt: raw.done && raw.doneAt ? str(raw.doneAt, 40) : "",
    note: str(raw.note, 300),
    doc: str(raw.doc, 40),
    auto: raw.auto === "walkthrough" ? "walkthrough" : "",
    custom: Boolean(raw.custom),
  };
}

/** normalizeChecklist(raw) → { items }. Nothing stored → the template. */
export function normalizeChecklist(raw) {
  const src = raw && typeof raw === "object" && Array.isArray(raw.items) ? raw.items : CHECKLIST_TEMPLATE;
  const seen = new Set();
  const items = [];
  for (const r of src) {
    const it = normalizeItem(r);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
    if (items.length >= MAX_ITEMS) break;
  }
  return { items };
}

/**
 * applyChecklistEdit(checklist, { id, done, due, owner, label, note, remove }, now) → checklist
 * One item. Unknown id → unchanged. `due: ""` goes back to the rule.
 */
export function applyChecklistEdit(checklist, edit = {}, now = Date.now()) {
  const cur = normalizeChecklist(checklist);
  const idx = cur.items.findIndex((i) => i.id === edit.id);
  if (idx < 0) return cur;
  if (edit.remove) return { items: cur.items.filter((_, i) => i !== idx) };
  const it = { ...cur.items[idx] };
  if (edit.done !== undefined) {
    it.done = Boolean(edit.done);
    it.doneAt = it.done ? new Date(now).toISOString() : "";
  }
  if (edit.due !== undefined) it.due = isYmd(edit.due) ? edit.due : "";
  if (edit.owner !== undefined && OWNER_KEYS.includes(edit.owner)) it.owner = edit.owner;
  if (edit.label !== undefined && str(edit.label, 160)) it.label = str(edit.label, 160);
  if (edit.note !== undefined) it.note = str(edit.note, 300);
  const items = [...cur.items];
  items[idx] = it;
  return normalizeChecklist({ items });
}

/** addChecklistItem(checklist, { gate, label, owner, due }) → checklist (new item last in its gate). */
export function addChecklistItem(checklist, add = {}, now = Date.now()) {
  const cur = normalizeChecklist(checklist);
  const it = normalizeItem({
    id: `c-${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    gate: add.gate, label: add.label, owner: add.owner, due: add.due, custom: true, rule: null,
  });
  if (!it) return cur;
  const lastInGate = cur.items.map((x) => x.gate).lastIndexOf(it.gate);
  const items = [...cur.items];
  items.splice(lastInGate < 0 ? items.length : lastInGate + 1, 0, it);
  return normalizeChecklist({ items });
}

/** tickByDoc(checklist, kind, now) → checklist with open items for that document kind ticked. */
export function tickByDoc(checklist, kind, now = Date.now()) {
  const cur = normalizeChecklist(checklist);
  if (!kind) return cur;
  return { items: cur.items.map((i) => (i.doc === kind && !i.done ? { ...i, done: true, doneAt: new Date(now).toISOString() } : i)) };
}

/** tickById(checklist, id, now) → checklist with that item ticked (no-op when missing or done). */
export function tickById(checklist, id, now = Date.now()) {
  const cur = normalizeChecklist(checklist);
  return { items: cur.items.map((i) => (i.id === id && !i.done ? { ...i, done: true, doneAt: new Date(now).toISOString() } : i)) };
}

/* ---------- dates ---------- */

const pacificYmd = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
};
const daysBetween = (fromYmd, toYmd) => {
  const a = fromYmd.split("-").map(Number), b = toYmd.split("-").map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / DAY_MS);
};

// When the deal entered a stage, as a Pacific date — the first time it did.
function stageEnteredYmd(deal, stage) {
  const hit = (deal?.stageHistory || []).find((h) => h?.stage === stage && Number.isFinite(Date.parse(h.ts)));
  return hit ? pacificYmd(Date.parse(hit.ts)) : "";
}

function ruleDue(rule, deal) {
  if (!rule) return "";
  let base = "";
  if (rule.from === "contract") {
    const t = Date.parse(deal?.createdAt || "");
    base = Number.isFinite(t) ? pacificYmd(t) : "";
  } else if (rule.from === "inspection") base = isYmd(deal?.inspectionDate) ? deal.inspectionDate : "";
  else if (rule.from === "closing") base = isYmd(deal?.closingDate) ? deal.closingDate : "";
  return base ? addDays(base, rule.days) : "";
}

function walkthroughFacts(deal) {
  const s = deal?.showing || {};
  const windows = (Array.isArray(s.windows) ? s.windows : []).map((w) => Date.parse(w?.start)).filter(Number.isFinite).sort((a, b) => a - b);
  const walked = (Array.isArray(s.rsvps) ? s.rsvps : []).some((r) => r?.status === "attended");
  return { firstWindowYmd: windows.length ? pacificYmd(windows[0]) : "", walked };
}

/**
 * resolveChecklist(deal, { docs, now }) → {
 *   items: [{ ...item, dueYmd, dueDays, state, gateLabel }],
 *   gates: { under_contract: { done, total }, ... },
 *   currentGate, open, next,
 * }
 *
 * state: "done" | "overdue" | "due_soon" | "open" | "later" (its gate's stage
 * hasn't started, so its date isn't knowable yet). `next` is the most urgent
 * open item in the current gate or any earlier one — what a person should
 * chase first.
 */
export function resolveChecklist(deal = {}, { docs = [], now = Date.now() } = {}) {
  const { items } = normalizeChecklist(deal?.checklist);
  const today = pacificYmd(now);
  const docKinds = new Set((docs || []).map((d) => d?.kind).filter(Boolean));
  const walk = walkthroughFacts(deal);
  const stage = deal?.stage || "under_contract";
  const currentGate = GATES.includes(stage) ? stage : null;
  const reached = currentGate ? GATES.slice(0, GATES.indexOf(currentGate) + 1) : (stage === "closed" ? [...GATES] : []);

  const out = items.map((it) => {
    let dueYmd = it.due || "";
    if (!dueYmd) {
      if (it.auto === "walkthrough") dueYmd = walk.firstWindowYmd;
      else if (it.rule?.from === "stage") {
        const entered = stageEnteredYmd(deal, it.gate);
        dueYmd = entered ? addDays(entered, it.rule.days) : "";
      } else dueYmd = ruleDue(it.rule, deal);
    }
    const done = it.done || (it.doc && docKinds.has(it.doc)) || (it.auto === "walkthrough" && walk.walked);
    const dueDays = dueYmd ? daysBetween(today, dueYmd) : null;
    const started = reached.includes(it.gate);
    const state = done ? "done"
      : !started ? "later"
      : dueDays != null && dueDays < 0 ? "overdue"
      : dueDays != null && dueDays <= DUE_SOON_DAYS ? "due_soon"
      : "open";
    return { ...it, done: Boolean(done), dueYmd, dueDays, state, gateLabel: GATE_LABEL[it.gate] };
  });

  const gates = Object.fromEntries(GATES.map((g) => {
    const mine = out.filter((i) => i.gate === g);
    return [g, { done: mine.filter((i) => i.done).length, total: mine.length }];
  }));
  const open = out.filter((i) => !i.done && reached.includes(i.gate));
  const urgency = (i) => (i.state === "overdue" ? 0 : i.state === "due_soon" ? 1 : 2);
  const next = [...open].sort((a, b) => urgency(a) - urgency(b)
    || (a.dueDays ?? 9999) - (b.dueDays ?? 9999)
    || out.indexOf(a) - out.indexOf(b))[0] || null;
  return { items: out, gates, currentGate, open, next };
}

/** openItemsForGate(deal, gate, opts) → the gate's items not yet done (for the soft-gate confirm). */
export function openItemsForGate(deal, gate, opts = {}) {
  return resolveChecklist(deal, opts).items.filter((i) => i.gate === gate && !i.done);
}

/** dueWords(item) → "2d overdue" | "due today" | "due in 3d" | "Oct 3" | "". */
export function dueWords(i) {
  if (!i || i.done || i.dueDays == null) return "";
  if (i.dueDays < 0) return `${-i.dueDays}d overdue`;
  if (i.dueDays === 0) return "due today";
  if (i.dueDays <= 7) return `due in ${i.dueDays}d`;
  const [y, m, d] = i.dueYmd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
