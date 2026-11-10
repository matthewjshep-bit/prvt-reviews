// needs-matt.js — puts an agent's card in GHL's "Needs Matt" stage while
// something only he can do is open, and takes it out when it's done.
//
// Matt, 2026-10-22: "Instead of ping to me they land there." The list of what
// lands there is shared/needs-matt.js (kept short on purpose); the move itself
// is shared/ghl-stages.js planCard's `needsMatt`, applied by tier-check.js
// syncAgentCard. This reads the pipeline (the read Today used), keeps the
// list on the `needsMatt` cursor for the 7am plan and every card sync, and
// syncs the cards whose need started or ended since the last read.
//
//   - Off unless ghlStages.mode is "on" and the Acquisitions pipeline has a
//     stage named "Needs Matt". No stage: the cursor is still kept (a
//     report), nothing moves.
//   - The cursor is written before any card moves; a run a deploy killed is
//     retried once it's stale (conversation-audit.js gating).
//   - The why goes on the card once per thing: the App ping why field and a
//     contact note, claimed by a `needs_matt_noted` event first.
//   - A house still unpriced PASS_AFTER_HOURS after it landed is marked we
//     passed ("went quiet") with its pass note due (Matt, 2026-10-22: "Land,
//     then bot passes"). Only with the stage there, like the moves. Since
//     2026-11-10 the clock counts working hours (weekdays, not the
//     conversationAi offDays), and a house the offer engine priced (any grade:
//     the draft's engine read or the house's record) is never passed by it;
//     it waits with the engine's number on the card.
//   - A house the bot settles itself never lands (shared/needs-matt.js
//     botTakesHouse): the agent called it cosmetic or done (passed at once,
//     "too turnkey", pass note due), or it has no house number (the address
//     chase's).
//   - Our answer to an agent's text that never arrived (the delivery check,
//     delivery-watch.js, while conversationAi.deliveryWatch is on) lands as
//     paper until a call, an email, a hand text or a new text from them.
//
// Never sends a text itself: the pass note goes through pass-note.js. Ids and
// kinds in the cursor and logs, no names.

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { recordError, scrubMessage } from "./app-errors.js";
import { updateContact, createContactNote } from "./ghl.js";
import { acquisitionsPipeline, pipelinesFor } from "./ghl-mirror.js";
import { syncAgentCard } from "./tier-check.js";
import { fieldId } from "./ghl-pings.js";
import { normalizeGhlStages, stageKeys } from "./shared/ghl-stages.js";
import { needsMattByContact, needsMattFromCursor, needsMattPassDue, botTakesHouse, NEEDS_MATT_CURSOR, NEEDS_MATT_EVENT } from "./shared/needs-matt.js";
import { engineNumberFor } from "./price-v2.js";
import { effectiveStatus } from "./shared/offer-status.js";
import { reopensOnTheirNumbers } from "./shared/held-underwrites.js";
import { ghlPingNote } from "./shared/ghl-pings.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { undeliveredAnswers, SEND_FAILED, UNDELIVERED_REACHED_TYPES, UNDELIVERED_ANSWER_DAYS } from "./shared/delivery.js";

export const STALE_RUN_MS = 30 * 60 * 1000;
export const MAX_SYNCS_PER_RUN = 40;
// Pacific hours the cards move: he isn't reading the board at 2am.
export const NEEDS_MATT_FROM = 7;
export const NEEDS_MATT_UNTIL = 21;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (n) => new Promise((r) => setTimeout(r, n));
// Agents whose failed answer is read through to their own timeline per run.
export const MAX_UNDELIVERED_READS = 50;

/**
 * undeliveredRows({ store, locationId, now }) → shared/delivery.js undeliveredAnswers rows
 *
 * Our answers that never arrived (delivery-watch.js), in two light reads:
 * the week's send_failed events, then only those agents' own timelines for
 * anything that reached them since. Not the whole location's summaries
 * every fifteen minutes (memory prod-heavy-reads-crash).
 */
export async function undeliveredRows({ store, locationId, now = Date.now() }) {
  const since = iso(now - UNDELIVERED_ANSWER_DAYS * 86400000);
  const fails = (await Promise.resolve().then(() => store.listContactEventsSince?.(locationId, since, { types: [SEND_FAILED], limit: 2000 })).catch(() => null)) || [];
  const answers = fails.filter((e) => e?.contactId && e.data?.answer === true && e.party !== "investor");
  const ids = [...new Set(answers.map((e) => e.contactId))].slice(0, MAX_UNDELIVERED_READS);
  const keep = new Set(ids);
  const events = answers.filter((e) => keep.has(e.contactId));
  for (const contactId of ids) {
    const theirs = (await Promise.resolve().then(() => store.listContactEvents?.(locationId, contactId, { since, types: [...UNDELIVERED_REACHED_TYPES], limit: 100 })).catch(() => null)) || [];
    for (const e of theirs) events.push({ ...e, contactId });
  }
  return undeliveredAnswers(events, { now });
}

async function patchCursor(store, locationId, patch) {
  const cur = await store.getJobCursor?.(locationId, NEEDS_MATT_CURSOR).catch(() => null);
  await store.setJobCursor?.(locationId, NEEDS_MATT_CURSOR, { at: iso(Date.now()), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
}

// What the cursor keeps per agent: kind, why, when, the claim key. No names.
// `placed`: the card was synced for this need (moved, already there, a
// person's drag that stands, or a skip); one a GHL error stopped is tried
// again next tick.
// `landedAt`: when the runner first saw this thing (the pass clock's start).
// `engine`: the offer engine's number on a price card ({ grade, open, walkAway }), which keeps the
// clock off it (2026-11-10).
const keep = (v, placed = false, landedAt = null) => ({ kind: v.kind, rowKind: v.rowKind || "", why: v.why || "", at: v.at || null, key: v.key, offerId: v.offerId || null, placed, landedAt,
  ...(v.engine ? { engine: v.engine } : {}) });

// The row kinds that can land as a price card, read for the engine's number.
const PRICE_ROW_KINDS = new Set(["price_it", "number_owed", "promise_owed", "draft_waiting"]);
// At most this many houses read for the engine's number per run (one light read each, past the
// offer itself).
export const MAX_ENGINE_READS = 80;

/**
 * runNeedsMatt({ store, locationId, client, saved, deps, now, dryRun, ghl })
 *   → { dryRun, stage, needs, entered, left, synced, moved, noted, errors, finishedAt }
 *
 *   deps.pipelineFor  routes/dashboard.js router.pipelineFor
 *   deps.syncAgentCard  tier-check.js syncAgentCard (tests stub it)
 */
export async function runNeedsMatt({ store = defaultStore, locationId, client, saved = {}, deps = {}, now = Date.now(), dryRun = false, ghl = null } = {}) {
  const out = { dryRun, stage: false, needs: 0, byKind: {}, entered: [], left: [], passDue: [], passed: [], screened: [], unknown: [], synced: 0, moved: 0, noted: 0, errors: [], finishedAt: null };
  const done = () => { out.finishedAt = iso(Date.now()); return out; };
  if (typeof deps.pipelineFor !== "function") throw new Error("runNeedsMatt needs deps.pipelineFor");
  const cfg = normalizeGhlStages(saved?.ghlStages);
  const acq = acquisitionsPipeline(await pipelinesFor(client, locationId, { ghl, now }));
  out.stage = Boolean(acq && stageKeys(acq).needsMatt);

  const read = await deps.pipelineFor({ locationId, client, now });
  // An answer of ours that never arrived (delivery-watch.js), while the
  // delivery check is on: a paper row until something reaches them.
  const undelivered = normalizeConversationAi(saved?.conversationAi).deliveryWatch?.enabled
    ? await undeliveredRows({ store, locationId, now })
    : [];
  const rows = [...(read.shownActions || []), ...(read.shownCalls || []), ...undelivered];
  // Each offer is read once per run, whichever check asks first.
  const offersRead = new Map();
  const offerOf = (id) => {
    if (!offersRead.has(id)) offersRead.set(id, Promise.resolve().then(() => store.getOffer?.(id)).catch(() => null));
    return offersRead.get(id);
  };
  // The houses waiting on his price, read first: one the bot settles itself
  // (botTakesHouse) never lands.
  const screened = new Map();
  for (const r of rows.flatMap((x) => [x, ...(x?.also || [])])) {
    if (!r?.offerId || screened.has(r.offerId) || !["price_it", "number_owed", "promise_owed"].includes(r.kind)) continue;
    const o = await offerOf(r.offerId);
    const v = o && o.locationId === locationId ? botTakesHouse(o) : null;
    screened.set(r.offerId, v);
    if (v) out.screened.push({ contactId: r.contactId || o.contactId || null, offerId: r.offerId, ...(v.pass ? { pass: v.pass } : { chase: true }) });
  }
  // Their number on a house we walked away from is answered by our pass, not
  // a house to price (Matt, 2026-11-09: Ed K., Mary S.). The held sweep's
  // quiet pass stays open to their numbers (reopensOnTheirNumbers).
  const walkedAway = new Set();
  for (const r of rows.flatMap((x) => [x, ...(x?.also || [])])) {
    if (r?.kind !== "draft_waiting" || !r.offerId || walkedAway.has(r.offerId)) continue;
    const o = await offerOf(r.offerId);
    if (o && o.locationId === locationId && effectiveStatus(o) === "we_passed" && !reopensOnTheirNumbers(o)) walkedAway.add(r.offerId);
  }
  // The offer engine's number on each house that could land as a price card
  // (2026-11-10): the card names it, and the pass clock leaves it alone.
  const engineByOffer = new Map();
  for (const r of rows.flatMap((x) => [x, ...(x?.also || [])])) {
    if (!r?.offerId || engineByOffer.has(r.offerId) || !PRICE_ROW_KINDS.has(r.kind) || engineByOffer.size >= MAX_ENGINE_READS) continue;
    const o = await offerOf(r.offerId);
    engineByOffer.set(r.offerId, o && o.locationId === locationId ? await engineNumberFor({ store, locationId, offer: o }) : null);
  }
  // The offers ride along: a held reply that quotes our terms, or asks for
  // the paper where our number is out, is read against them (hand-off.js).
  const needs = needsMattByContact(rows, { drafts: read.drafts || [], offers: read.offers || [], now, screened, walkedAway, engineByOffer });
  const cur = await store.getJobCursor?.(locationId, NEEDS_MATT_CURSOR).catch(() => null);
  const prev = needsMattFromCursor(cur?.doc);
  // A held-draft read that hit its cap (routes/dashboard.js, 2026-11-09): a
  // card missing from it is unknown, not done. It keeps its place on the
  // stage and its clock, and isn't passed off it, until a whole read says.
  const unknown = new Set();
  if (read.capped?.held) {
    for (const [id, v] of prev) if (!needs.has(id)) { needs.set(id, { ...v }); unknown.add(id); }
  }
  out.unknown = [...unknown].map((id) => ({ contactId: id }));
  // The pass clock starts when the thing first landed, kept across reads.
  for (const [id, v] of needs) v.landedAt = prev.get(id)?.key === v.key && prev.get(id)?.landedAt ? prev.get(id).landedAt : iso(now);
  out.needs = needs.size;
  for (const v of needs.values()) out.byKind[v.kind] = (out.byKind[v.kind] || 0) + 1;

  const entered = [...needs.keys()].filter((id) => prev.get(id)?.key !== needs.get(id).key || prev.get(id)?.placed === false);
  const left = [...prev.keys()].filter((id) => !needs.has(id));
  out.entered = entered.map((id) => ({ contactId: id, kind: needs.get(id).kind }));
  out.left = left.map((id) => ({ contactId: id }));
  // Working days only, and not his days off (2026-11-10).
  const offDays = normalizeConversationAi(saved?.conversationAi).autoSend?.offDays || [];
  out.passDue = [...needs].filter(([id, v]) => !unknown.has(id) && needsMattPassDue(v, now, { offDays })).map(([id, v]) => ({ contactId: id, offerId: v.offerId }));
  if (dryRun) return done();

  // The list first: the 7am plan and every card sync read it from here.
  const kept = Object.fromEntries([...needs].map(([id, v]) => [id, keep(v, prev.get(id)?.key === v.key ? prev.get(id)?.placed !== false : false, v.landedAt)]));
  await patchCursor(store, locationId, { needs: kept, readAt: iso(now) });
  if (!out.stage || cfg.mode !== "on") return done();

  // Waited out, or the agent's own words say it isn't a flip: passed, and the
  // pass note tells them. A waited-out card leaves on the next read.
  const toPass = [...out.passDue.map((x) => ({ ...x, reason: "quiet" })),
    ...out.screened.filter((x) => x.pass && x.contactId).map((x) => ({ contactId: x.contactId, offerId: x.offerId, reason: x.pass }))];
  for (const { contactId, offerId, reason } of toPass) {
    try {
      if (await passUnpriced({ store, locationId, client, contactId, offerId, reason, now })) out.passed.push({ contactId, offerId });
    } catch (e) {
      await recordError(store, { locationId, area: "needs-matt", err: e, context: { contactId, offerId, stage: "pass" } });
      out.errors.push(`${contactId}: ${scrubMessage(e).slice(0, 120)}`);
    }
  }

  const sync = deps.syncAgentCard || syncAgentCard;
  const work = [...entered.map((id) => ({ id, need: needs.get(id) })), ...left.map((id) => ({ id, need: null }))].slice(0, MAX_SYNCS_PER_RUN);
  let field = null;
  for (const { id, need } of work) {
    const r = await sync({ client, locationId, contactId: id, store, saved, ghl, needsMatt: need ? keep(need, false, need.landedAt) : null, now });
    out.synced++;
    if (r?.applied) out.moved++;
    if (r?.error) out.errors.push(`${id}: ${r.error}`);
    // Only a GHL error is tried again: a skip (two open cards, not an agent)
    // stays one until the 7am plan reads it fresh.
    const placed = Boolean(r && !r.error);
    if (need && placed) kept[id] = { ...kept[id], placed: true };
    // Into the stage: say why on the card, once per thing.
    if (need && (r?.applied || /already in needs matt/i.test(String(r?.skip || "")))) {
      const claim = await recordEvent({ store, locationId, contactId: id, type: NEEDS_MATT_EVENT, at: iso(now), source: "sweep",
        offerId: need.offerId || null, dedupeKey: need.key, data: { kind: need.kind, rowKind: need.rowKind || "" } }).catch(() => null);
      if (claim?.inserted) {
        try {
          field = field || await fieldId({ store, locationId, client });
          await updateContact(client, id, { customFields: [{ id: field.id, value: need.why }] });
          await createContactNote(client, id, { body: ghlPingNote(need.why) }).catch(() => null);
          out.noted++;
        } catch (e) {
          await recordError(store, { locationId, area: "needs-matt", err: e, context: { contactId: id, kind: need.kind } });
          out.errors.push(`${id}: ${scrubMessage(e).slice(0, 120)}`);
          field = null;
        }
      }
    }
    await sleep(100);
  }
  await patchCursor(store, locationId, { needs: kept });
  return done();
}

// One house: still a draft nothing went out on (re-read, so a price he put on
// it since the pipeline read wins), marked we passed the way the held sweep
// closes a quiet house. pass-note.js sends the note in machine hours.
const PASS_WHY = {
  quiet: { note: "it waited three working days in Needs Matt with no price", retired: "no price three working days after it landed in Needs Matt" },
  turnkey: { note: "the agent called it cosmetic or done", retired: "the agent's own words: not a flip" },
};
async function passUnpriced({ store, locationId, client, contactId, offerId, reason = "quiet", now }) {
  const why = PASS_WHY[reason] || PASS_WHY.quiet;
  const full = await store.getOffer?.(offerId).catch(() => null);
  if (!full || full.locationId !== locationId || full.deal || effectiveStatus(full) !== "draft") return false;
  if ((full.sends || []).length || full.floatSentAt) return false;
  // The clock never passes a house the engine priced (2026-11-10), even one it priced since the read.
  if (reason === "quiet" && await engineNumberFor({ store, locationId, offer: full })) return false;
  const ts = iso(now);
  const street = String(full.address || "").split(",")[0].trim() || "the house";
  const note = `We passed on ${street}: ${why.note}. The bot's pass note tells the agent.`;
  await store.updateOffer(full.id, {
    ...full, status: "we_passed", statusAt: ts, statusNote: note,
    statusHistory: [...(full.statusHistory || []), { status: "we_passed", ts, note }],
    retired: { at: ts, by: "needs-matt", reason: why.retired },
    passReason: { code: reason, at: ts, by: "needs-matt" }, passNote: { status: "due", markedAt: ts }, updatedAt: ts,
  });
  await recordEvent({ store, locationId, contactId, party: "agent", type: "offer_we_passed", at: ts, address: full.address || "", offerId: full.id,
    source: "sweep", dedupeKey: `needs_matt_passed:${full.id}`, data: { phrase: note, by: "needs-matt" } }).catch(() => {});
  await createContactNote(client, contactId, { body: note }).catch(() => {});
  return true;
}

/* ---------- the tick: every 15 minutes, 7am–9pm Pacific ---------- */

const pacificHour = (t) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(t))) % 24;
const running = new Set();
export function _resetNeedsMatt() { running.clear(); }

// What a run did, for the cursor: ids and kinds, never what was said.
export const summarizeNeedsMatt = (r) => ({
  finishedAt: r?.finishedAt || null, stage: Boolean(r?.stage), needs: r?.needs ?? 0, byKind: r?.byKind || {},
  entered: (r?.entered || []).length, left: (r?.left || []).length, passed: (r?.passed || []).length, screened: (r?.screened || []).length, unknown: (r?.unknown || []).length, moved: r?.moved ?? 0, noted: r?.noted ?? 0,
  errors: (r?.errors || []).slice(0, 5),
});

/**
 * maybeRunNeedsMatt({ client, locationId, saved, store, deps, now }) → { ran } | null
 *
 * Only with ghlStages.mode "on". Every tick in the hours; a run that died
 * under a deploy is retried once it's stale.
 */
export async function maybeRunNeedsMatt({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  if (normalizeGhlStages(saved?.ghlStages).mode !== "on") return null;
  const h = pacificHour(now);
  if (h < NEEDS_MATT_FROM || h >= NEEDS_MATT_UNTIL) return null;
  if (running.has(locationId)) return null;
  const cursor = await store.getJobCursor?.(locationId, NEEDS_MATT_CURSOR).catch(() => null);
  const started = Date.parse(cursor?.doc?.run?.startedAt || "");
  if (Number.isFinite(started) && now - started < STALE_RUN_MS) return null;
  await patchCursor(store, locationId, { run: { startedAt: iso(now) } });
  running.add(locationId);
  try {
    const r = await runNeedsMatt({ store, locationId, client, saved, deps, now });
    await patchCursor(store, locationId, { run: null, last: summarizeNeedsMatt(r) });
  } catch (e) {
    await recordError(store, { locationId, area: "needs-matt", err: e, context: { stage: "tick" } });
    await patchCursor(store, locationId, { run: null, last: { error: scrubMessage(e).slice(0, 200), finishedAt: iso(Date.now()) } });
  } finally {
    running.delete(locationId);
  }
  return { ran: true };
}
