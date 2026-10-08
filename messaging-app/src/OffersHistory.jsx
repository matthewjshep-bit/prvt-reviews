// OffersHistory.jsx — the landing view: every offer created for this location,
// grouped by agent (contact), with its outcome. One collapsible row per agent,
// individual offers nested under it. The agent's name opens their record.
//
// Clicking an offer opens the split (2026-10-01, Matt: the offer and the
// person were "2-3 separate pages"): the table shrinks to a rail of the rows
// it was showing, and the offer is worked in the same pane as a Today row —
// the offer on the left, the conversation and a reply box on the right
// (OfferPane.jsx). J/K walk the rail, Esc goes back to the table, Details
// opens the full offer window. The open offer is kept in `?offer=<id>`.
//
// This is where the day is worked, so the table is organized around the one
// question that matters at 10 offers a day: which of these is still alive?
// Hence the status column (a control, not a label — you set an outcome from
// the row itself), the filter chips that answer it in one tap, and the KPI
// strip that turns 120-offers-to-1-contract into numbers you can watch.
//
// Status lives in shared/offer-status.js; nothing here decides what a status
// means, only how it looks and how you change it.

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Pencil, Send, Sparkles, Trash2, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { assetLabel, normalizeAsset } from "@shared/asset-type.js";
import { annotateCurrent, houseKey } from "@shared/current-offer.js";
import {
  OFFER_STATUS, OFFER_STATUS_KEYS, effectiveStatus, isAiGenerated, needsAiReview,
  toListOffer,
} from "@shared/offer-status.js";
import {
  deleteOffer, getOffer, getSettings, ghlContactUrl, listOffers, promoteDeal,
  setOfferStatus, setOfferStatusBulk, MAKE_CURRENT, requoteOffer,
} from "./api.js";
import SendModal, { CHANNEL_LABELS } from "./SendModal.jsx";
import ContactLink from "./ContactLink.jsx";
import ContractModal from "./ContractModal.jsx";
import PsaModal from "./PsaModal.jsx";
import AssignmentModal from "./AssignmentModal.jsx";
import NetSheetModal from "./NetSheetModal.jsx";
import EnrichModal from "./EnrichModal.jsx";
import OfferPageModal from "./OfferPageModal.jsx";
import OfferDetailModal from "./OfferDetailModal.jsx";
import UnderwriteStrip from "./UnderwriteStrip.jsx";
import OfferRail from "./OfferRail.jsx";
import OfferPane from "./OfferPane.jsx";
import { railStep, readOfferParam, splitKey, writeOfferParam } from "./offers-split.js";
import { OPEN_OFFER_EVENT } from "./PaneParts.jsx";
import { REPLY_BOX_ID } from "./ConversationPanel.jsx";
import { TEACH_EVENT } from "./RowFeedback.jsx";
import { offerKey, siblingsKey } from "./OfferPanel.jsx";
import { forget, forgetPrefix } from "./work-data.js";
import NextFollowUp, { groupNext, nextSortKey } from "./NextFollowUp.jsx";
import { TABS, OTHER, viewFor, defaultTab, notSentAge, waitingSince } from "./offer-tabs.js";
import {
  ActivityStamp, AiPill, AttachWarning, BTN, BTN_ICON, BTN_PRIMARY, EmptyState, ErrorBar, FilterChips, KpiRow, Menu,
  SearchInput, SkeletonRows, SortHeader, StatusDots, StatusMenu, StatusPill, TableCard,
  compareBy, rowActivation, useSort,
} from "./ui.jsx";

// The agent's last communication, across all their offers. Per-agent is the
// honest grain — a text or a call is with a person, not about a house — so
// every offer of theirs carries the same stamp and the group header shows it.
const groupActivity = (offers) =>
  offers.reduce((best, o) => (o.lastActivity?.at && (!best || o.lastActivity.at > best.at) ? o.lastActivity : best), null);

// Compact "what went out" label for a sends entry: "text+email · 07-29".
const sendLabel = (s) =>
  `${s.channels.map((c) => CHANNEL_LABELS[c] || c).join("+")} · ${(s.ts || "").slice(5, 10)}`;

function SentBadge({ offer }) {
  const sends = offer.sends || [];
  if (!sends.length) return null;
  const last = sends[sends.length - 1];
  const failed = Object.values(last.results || {}).some((r) => !r.ok);
  const title = sends
    .map((s) => `${(s.ts || "").slice(0, 16).replace("T", " ")} — ${s.channels
      .map((c) => `${CHANNEL_LABELS[c] || c}${s.results?.[c]?.ok === false ? ` (failed: ${s.results[c].error})` : ""}`)
      .join(", ")} · docs: ${(s.docs || []).join(", ")}`)
    .join("\n");
  return (
    <span className={`ml-1.5 whitespace-nowrap text-[11px] ${failed ? "text-amber-700" : "text-slate-400"}`} title={title}>
      {failed ? "⚠ " : ""}{sendLabel(last)}
    </span>
  );
}

/* ---------- tabs ---------- */

// Three tabs — Hot · Not sent · Sent — and a "Closed / other" menu for the
// rest (offer-tabs.js; Matt, 2026-10-07). Counts come from running each test
// over the search-filtered set, so a tab's number always matches what
// clicking it shows.

/* ---------- sorting ---------- */

// What each sortable column reads off a row, and which way round it should
// start. Dates and money open on the biggest/most recent, because that is the
// question being asked when you click them; names open A→Z.
//
// Status sorts by FUNNEL POSITION, not alphabetically: draft → not sent → sent
// → countered → no response → they passed → we passed → accepted. "Countered"
// landing between "sent" and "passed" is the useful order; landing next to "draft" because
// both start with a letter near C is not.
const SORTS = {
  agent: { natural: "asc", of: (o) => o.contactName || "" },
  date: { natural: "desc", of: (o) => o.createdAt || "" },
  property: { natural: "asc", of: (o) => o.address || "" },
  cash: { natural: "desc", of: (o) => (o.cashAmount != null ? Number(o.cashAmount) : null) },
  status: { natural: "asc", of: (o) => OFFER_STATUS_KEYS.indexOf(effectiveStatus(o)) },
  // Sorting runs before grouping, so this orders the AGENTS by how recently
  // anyone spoke to them — the most useful reading of the column. compareBy
  // sinks nulls in both directions, so agents you've never contacted stay at
  // the bottom whichever way you click.
  activity: { natural: "desc", of: (o) => o.lastActivity?.at || null },
  // Soonest first; nothing coming sinks (compareBy), whichever way you click.
  next: { natural: "asc", of: nextSortKey },
  // Not sent: the offer that has waited longest for paper first.
  waiting: { natural: "asc", of: waitingSince },
};

// One agent, one group. Offers with no contact record still collapse together
// by name, and everything nameless lands in one bucket rather than one group
// each.
const groupKeyOf = (o) => o.contactId || (o.contactName ? `name:${o.contactName}` : "none");

const LIVE_STAGES = new Set(["under_contract", "buyer_found", "assigned"]);

// An agent's rows, one house at a time: houses in the order the sort put
// them, and inside each the current offer first, then what it superseded,
// then drafts. A house's history reads top-down from the number that's live.
function byHouse(list) {
  const houses = new Map();
  for (const o of list) {
    const k = houseKey(o.address || "") || o.id;
    if (!houses.has(k)) houses.set(k, []);
    houses.get(k).push(o);
  }
  const rank = (o) => (o.status === "draft" ? 2 : o.supersededBy ? 1 : 0);
  return [...houses.values()].flatMap((rows) => rows.map((o, i) => [o, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([o]) => o));
}

export default function OffersHistory({ onEdit, onDeal, settings: appSettings = null }) {
  const [offers, setOffers] = useState(null);
  // The split: the offer open beside the rail, and the rail's rows — the
  // table's order, frozen when it opened (re-frozen when the filter, search or
  // sort changes) so recording an outcome doesn't renumber it under you.
  const [openId, setOpenId] = useState(() => (typeof window !== "undefined" ? readOfferParam() : null));
  const [railIds, setRailIds] = useState(null);
  const [closedId, setClosedId] = useState(null);   // scroll back to it in the table
  const liveRail = useRef([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null); // the OPEN offer, hydrated (see openDetail)
  const [opening, setOpening] = useState(null);   // offer id being hydrated
  const [sending, setSending] = useState(null);
  const [psaing, setPsaing] = useState(null); // offer open in PsaModal (the WA purchase & sale agreement)
  const [contracting, setContracting] = useState(null); // offer open in ContractModal
  const [assigning, setAssigning] = useState(null); // offer open in AssignmentModal
  const [netSheeting, setNetSheeting] = useState(null); // offer open in NetSheetModal
  const [enriching, setEnriching] = useState(null); // { contactId, contactName } in EnrichModal
  const [offerPaging, setOfferPaging] = useState(null); // offer open in OfferPageModal
  const [settings, setSettings] = useState(null); // fetched lazily for contract prefills
  const [q, setQ] = useState("");
  // null until you pick one: the page opens on Hot, or Not sent when nothing
  // is hot (defaultTab), decided once the book is here.
  const [filter, setFilter] = useState(null);
  const [sort, toggleSort] = useSort({ key: "date", dir: "desc" }); // newest first, as the API returns them
  const [queueIds, setQueueIds] = useState(null); // the rows the popout's arrows walk, frozen at open
  const [expanded, setExpanded] = useState(() => new Set()); // group keys open
  const [picked, setPicked] = useState(() => new Set()); // offer ids selected for bulk
  const [statusBusy, setStatusBusy] = useState(null); // offer id whose status is in flight
  const [bulkBusy, setBulkBusy] = useState(false);
  const [promoting, setPromoting] = useState(null); // offer id in flight

  function toggleGroup(key) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // Every offer for the location, as lean table rows. It used to be the newest
  // 100 whole documents, which silently hid everything older than the cap —
  // agents, passed offers, even live deals — from the chips, the search box and
  // the KPI strip alike. The row is ~1KB, so the whole book fits; a fat field
  // is fetched on demand by hydrate().
  useEffect(() => {
    listOffers({ limit: 2000, lean: true, activity: true, next: true })
      .then(setOffers)
      .catch((e) => setError(e.message));
  }, []);

  // The selection describes the CURRENT view — narrowing it must never leave
  // hidden rows in the batch, or "mark 12 passed" quietly touches rows you
  // can't see. Same rule Agent Outreach uses.
  useEffect(() => { setPicked(new Set()); }, [q, filter]);
  // Hot and Not sent open every agent (each row's Send is the point); the
  // others start folded. A new tab starts from its own default.
  useEffect(() => { setExpanded(new Set()); }, [filter]);

  /* ---------- the split ---------- */

  // A new filter, search or sort while an offer is open: the rail is the new
  // list (liveRail is the order the table would show, set during render).
  // Not before the book is here: an empty rail would read as "frozen".
  useEffect(() => { if (openId && offers) setRailIds(liveRail.current); }, [q, filter, sort.key, sort.dir]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Opened from a link (?offer=): once the book is here, freeze the rail —
  // switching to All once if the offer isn't in the default filter — and let
  // go of an offer that no longer exists.
  useEffect(() => {
    if (!openId || !offers || railIds !== null) return;
    if (!offers.some((o) => o.id === openId)) { setOpenId(null); writeOfferParam(null); return; }
    if (!liveRail.current.includes(openId) && filter !== "all") { setFilter("all"); return; }
    setRailIds(liveRail.current);
  }, [offers, openId, filter]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Back in the table: the row you left from, in view.
  useEffect(() => {
    if (!closedId || openId) return;
    try { document.querySelector(`[data-offer-row="${CSS.escape(closedId)}"]`)?.scrollIntoView({ block: "center" }); } catch { /* old browser */ }
  }, [closedId, openId]);

  // The split's keys (offers-split.js splitKey): J/K walk the rail, R the
  // reply box, T feedback, O the editor, Esc back to the table. Read through
  // a ref: the rail and the open offer are worked out below the early returns.
  const splitNav = useRef(null);
  useEffect(() => {
    function onKey(e) {
      const nav = splitNav.current;
      if (!nav) return;
      const intent = splitKey(e, { blocked: nav.blocked });
      if (!intent) return;
      e.preventDefault();
      if (intent === "next") nav.go(1);
      else if (intent === "prev") nav.go(-1);
      else if (intent === "close") nav.close();
      else if (intent === "reply") document.getElementById(REPLY_BOX_ID)?.focus();
      else if (intent === "teach") window.dispatchEvent(new Event(TEACH_EVENT));
      else if (intent === "offer") window.dispatchEvent(new Event(OPEN_OFFER_EVENT));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // One person's rows again, with what's next — after a send, a status, a
  // Stop or a pace from the pane. The table keeps everything else.
  async function refreshContact(contactId) {
    if (!contactId) return;
    try {
      const rows = await listOffers({ contactId, lean: true, next: true, limit: 50 });
      const byId = new Map((rows || []).map((o) => [o.id, o]));
      setOffers((list) => (list || []).map((o) => (byId.has(o.id) ? { ...byId.get(o.id), lastActivity: o.lastActivity } : o)));
    } catch { /* the column says "updates on reload" until then */ }
  }

  // One patcher for every copy of an offer we're holding. The table keeps the
  // lean row it was loaded with; whatever is open keeps the whole document.
  function patchOffer(updated) {
    if (!updated) return;
    // The split's pane reads its own copies (work-data.js): they're stale now.
    forget(offerKey(updated.id), siblingsKey(updated.contactId));
    forgetPrefix(`timeline:${updated.contactId}:`);
    const patch = (o) => (o && o.id === updated.id ? updated : o);
    // The per-request columns aren't on the document: keep the agent's last
    // activity, and say the schedule is recomputed on reload rather than show
    // one worked out for the old status.
    setOffers((list) => (list || []).map((o) => (o.id === updated.id
      ? { ...toListOffer(updated), lastActivity: o.lastActivity, floatedAt: o.floatedAt,
          nextFollowUp: o.nextFollowUp && effectiveStatus(o) !== effectiveStatus(updated) ? { stale: true } : o.nextFollowUp }
      : o)));
    setSelected(patch);
    setSending(patch);
    setContracting(patch);
    setAssigning(patch);
    setNetSheeting(patch);
  }

  // Table rows are the lean projection. Anything that reads a fat field — the
  // popout (calc.offers, statusHistory, scope), the editor (draft/snapshot),
  // every generator — takes the real document, fetched here.
  // Two kinds of stub reach this: a lean table row (listOnly), and a bare
  // { id } from something that only ever knew an offer's id — the
  // auto-underwrite strip's "Review draft" being the one that exists. The old
  // test was listOnly alone, so a bare id sailed through unhydrated and opened
  // the editor on an object with no draft in it: a form that restores
  // completely empty, with nothing to say why.
  //
  // createdAt is the tell. Every stored offer has one and so does every lean
  // row; only a hand-made stub doesn't.
  async function hydrate(o) {
    if (!o?.id) return o;
    if (!o.listOnly && o.createdAt) return o;
    return (await getOffer(o.id)) || o;
  }

  // Open the popout / the editor on a row: fetch first, then hand over. The row
  // marks itself busy meanwhile, so a slow fetch reads as loading, not as a
  // dead click.
  async function openWith(o, use) {
    if (opening) return;
    setOpening(o.id);
    try { use(await hydrate(o)); }
    catch (e) { setError(e.message); }
    setOpening(null);
  }
  const openDetail = (o) => openWith(o, setSelected);
  const openEdit = (o) => openWith(o, (full) => onEdit?.(full));

  async function remove(o) {
    const msg = o.deal
      ? "This offer is an active deal — deleting removes the deal tracking too. Delete anyway?"
      : "Delete this offer record and its documents?";
    if (!window.confirm(msg)) return;
    try {
      await deleteOffer(o.id);
      setOffers((list) => list.filter((x) => x.id !== o.id));
      setSelected((sel) => (sel && sel.id === o.id ? null : sel));
      setPicked((prev) => { const n = new Set(prev); n.delete(o.id); return n; });
    } catch (e) { setError(e.message); }
  }

  // Promote an accepted offer into an active deal, then jump to the Deals tab.
  async function promote(o) {
    if (promoting) return;
    setPromoting(o.id);
    try {
      const r = await promoteDeal(o.id);
      patchOffer(r.offer);
      onDeal?.();
    } catch (e) {
      if (e.status === 409) onDeal?.(); // already a deal — just go there
      else setError(e.message);
    }
    setPromoting(null);
  }

  // Record an outcome from the row. "accepted" promotes server-side and comes
  // back flagged, so the one action lands you on the deal it just created.
  async function changeStatus(o, status) {
    if (statusBusy) return;
    setStatusBusy(o.id);
    setError("");
    try {
      const r = await setOfferStatus(o.id, status);
      // A pin moves: the server cleared it on this row's siblings, so do the
      // same to our copies before the row itself lands.
      if (status === MAKE_CURRENT && r.offer) {
        const k = `${r.offer.contactId}|${houseKey(r.offer.address || "")}`;
        setOffers((list) => (list || []).map((x) => (x.id !== r.offer.id && x.pin && `${x.contactId}|${houseKey(x.address || "")}` === k ? { ...x, pin: undefined } : x)));
      }
      patchOffer(r.offer);
      // Promotion navigates to the Deals tab — leaving the popout open over it
      // would strand you on top of the thing you just landed on.
      if (r.promoted) { closeDetail(); onDeal?.(); }
    } catch (e) { setError(e.message); }
    setStatusBusy(null);
  }

  // "Re-quote at 400K" from the held-paper banner: re-priced in place, sent
  // by nobody — Send is the next press.
  const [requoting, setRequoting] = useState(false);
  async function requote(o, amount) {
    if (!o?.id || requoting) return;
    setRequoting(true);
    setError("");
    try { patchOffer((await requoteOffer(o.id, amount)).offer); } catch (e) { setError(e.message); }
    setRequoting(false);
  }

  async function bulkStatus(status) {
    const ids = [...picked];
    if (!ids.length || bulkBusy) return;
    setBulkBusy(true);
    setError("");
    try {
      const r = await setOfferStatusBulk(ids, status);
      const byId = new Map((r.offers || []).map((o) => [o.id, toListOffer(o)]));
      setOffers((list) => (list || []).map((o) => (byId.has(o.id) ? { ...byId.get(o.id), lastActivity: o.lastActivity, floatedAt: o.floatedAt } : o)));
      setPicked(new Set());
      const failed = (r.results || []).filter((x) => !x.ok);
      if (failed.length) {
        setError(`${failed.length} of ${ids.length} couldn't be updated — ${failed[0].error}`);
      }
    } catch (e) { setError(e.message); }
    setBulkBusy(false);
  }

  // A live send appends to offer.sends and can advance the status. The server
  // returns those as loose fields, not a whole offer, so they merge onto the
  // copies we hold — keyed by the id the caller passes, since the patch itself
  // carries none. (It used to be handed to patchOffer, which matches on
  // patch.id and therefore quietly updated nothing at all.)
  function handleSent(id, sends, fields) {
    const patch = (o) => (o && o.id === id ? { ...o, sends, ...(fields || {}) } : o);
    setOffers((list) => (list || []).map(patch));
    setSelected(patch);
    setSending(patch);
  }

  function openPsa(offer) {
    setPsaing(offer);
    // Buyer entity, title company and the exhibit files all prefill from
    // settings.psa; fetch once, best-effort.
    if (!settings) getSettings().then(setSettings).catch(() => {});
  }

  function openContract(offer) {
    setContracting(offer);
    // Buyer-name prefill comes from settings.company; fetch once, best-effort.
    if (!settings) getSettings().then(setSettings).catch(() => {});
  }

  function openAssignment(offer) {
    setAssigning(offer);
    // Assignor-name prefill comes from settings.company; fetch once, best-effort.
    if (!settings) getSettings().then(setSettings).catch(() => {});
  }

  function openNetSheet(offer) {
    setNetSheeting(offer);
    // Commission-% prefills come from settings; fetch once, best-effort.
    if (!settings) getSettings().then(setSettings).catch(() => {});
  }

  if (error && !offers) return <ErrorBar>{error}</ErrorBar>;
  if (!offers) return <SkeletonRows cols={7} rows={8} />;
  if (!offers.length) {
    return (
      <EmptyState>No offers yet — hit <span className="font-semibold text-slate-500">New Offer</span> to create your first one.</EmptyState>
    );
  }

  /* ---------- derive: search → filter → group ---------- */

  // Every row told whether it is its house's current offer. Derived here, not
  // stored, so a status change or a pin patched into `offers` re-reads.
  const book = annotateCurrent(offers);
  const needle = q.trim().toLowerCase();
  const searched = !needle
    ? book
    : book.filter((o) =>
        [
          o.contactName,
          o.address,
          (o.createdAt || "").slice(0, 10),
          o.cashAmount != null ? String(o.cashAmount) : "",
          o.cashAmount != null ? fmtMoney(o.cashAmount) : "",
          // So typing "ai" narrows to auto-underwritten rows, and "held" to the
          // ones that stopped for review.
          isAiGenerated(o) ? `ai auto-underwrite ${(o.autoUnderwrite.held || []).length ? "held review" : ""}` : "",
        ].some((v) => (v || "").toLowerCase().includes(needle)));

  const usesAi = book.some(isAiGenerated);
  const view = filter ?? defaultTab(book);
  const chips = TABS.map((f) => ({ key: f.key, label: f.label, title: f.title, count: searched.filter(f.test).length }));
  const others = OTHER.filter((f) => !f.onlyWhenUsed || usesAi);
  const activeFilter = viewFor(view);
  const inOther = others.some((f) => f.key === view);
  const otherMenu = (
    <Menu label="Closed and other offers"
      trigger={<span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${inOther ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
        {inOther ? activeFilter.label : "Closed / other"} <ChevronDown size={12} aria-hidden="true" />
      </span>}
      items={others.map((f) => ({ key: f.key, label: `${f.label} · ${searched.filter(f.test).length}`, title: f.title,
        selected: f.key === view, onSelect: () => setFilter(f.key) }))} />
  );
  // Hot and Not sent open with every agent unfolded; `expanded` then holds the
  // ones you folded, not the ones you opened.
  const autoOpen = view === "hot" || view === "unsent";
  const openGroup = (key) => setExpanded((prev) => { const n = new Set(prev); autoOpen ? n.delete(key) : n.add(key); return n; });
  // Not sent reads oldest first until you click a column.
  const sortBy = view === "unsent" && sort.key === "date" && sort.dir === "desc" ? { key: "waiting", dir: "asc" } : sort;
  // Sorted BEFORE grouping, which is what makes the groups follow the sort:
  // an agent lands wherever their leading offer lands, exactly as they used to
  // land by their most recent one (see the grouping note below).
  const shown = searched
    .filter(activeFilter.test)
    .slice()
    .sort(compareBy(sortBy.key, sortBy.dir, (o, key) => (SORTS[key] || SORTS.date).of(o)));

  // KPIs run over every offer for the location, not the filtered view — they're
  // the state of the business, not of the current query.
  const real = book.filter((o) => o.status !== "draft" && !o.supersededBy);
  const monthAgo = Date.now() - 30 * 86400000;
  const recent = real.filter((o) => new Date(o.createdAt || 0).getTime() >= monthAgo).length;
  const unsentRows = real.filter(TABS[1].test);
  const oldestWait = unsentRows.reduce((m, o) => Math.min(m, waitingSince(o) ?? Infinity), Infinity);
  // Reply rate: of everything that actually went out, how much came back with
  // an answer of any kind. "No response" is a non-reply, so it sits in the
  // denominator only — which is the point of tracking it separately.
  const delivered = real.filter((o) => effectiveStatus(o) !== "new").length;
  const replied = real.filter((o) => ["countered", "passed", "accepted"].includes(effectiveStatus(o))).length;
  const liveDeals = real.filter((o) => o.deal && LIVE_STAGES.has(o.deal.stage)).length;
  const kpis = [
    { label: "Offers (30d)", value: recent, hint: "Non-draft offers created in the last 30 days" },
    { label: "Not sent", value: unsentRows.length ? `${unsentRows.length} · oldest ${Math.max(0, Math.floor((Date.now() - oldestWait) / 86400000))}d` : 0,
      hint: "Priced but not on paper yet — every agent should have our number on file" },
    { label: "Reply rate", value: delivered ? `${Math.round((replied / delivered) * 100)}%` : "—", hint: `${replied} answered of ${delivered} sent` },
    { label: "Live deals", value: liveDeals, hint: "Under contract, buyer found, or assigned" },
  ];

  // Group offers by agent. First appearance orders the groups, so they inherit
  // whatever the column sort just decided: newest-first by default, and by
  // price (or address, or funnel position) the moment you click that header.
  const groups = [];
  const byKey = new Map();
  for (const o of shown) {
    const key = groupKeyOf(o);
    let g = byKey.get(key);
    if (!g) {
      g = { key, contactId: o.contactId, contactName: o.contactName, offers: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.offers.push(o);
  }

  // Bulk applies to real, un-promoted offers: drafts have no outcome and a
  // deal's stage is changed on the Deals tab, so neither is selectable.
  const selectable = shown.filter((o) => o.status !== "draft" && !o.deal);
  const allPicked = selectable.length > 0 && selectable.every((o) => picked.has(o.id));
  const toggleAll = () =>
    setPicked(allPicked ? new Set() : new Set(selectable.map((o) => o.id)));
  const togglePick = (id) =>
    setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const clearFilters = () => { setQ(""); setFilter("all"); };

  // Opening a row opens the split, whose rail is the list it came out of, in
  // the order the table is showing it, so J/K walk the filter you are
  // working. It is FROZEN at open: recording an outcome drops that offer out
  // of "Awaiting reply", and a rail that re-derived itself would renumber
  // under you and skip the row you were about to reach. (The full offer
  // window, Details, no longer walks a queue of its own.)
  const rowsInOrder = groups.flatMap((g) => g.offers);
  liveRail.current = rowsInOrder.map((o) => o.id);
  const closeDetail = () => { setSelected(null); setQueueIds(null); };
  const openSplit = (o) => { setRailIds(rowsInOrder.map((x) => x.id)); setOpenId(o.id); setClosedId(null); writeOfferParam(o.id); };
  const byIdAll = new Map(book.map((o) => [o.id, o]));
  const openOffer = openId ? byIdAll.get(openId) || null : null;
  const railRows = (railIds || liveRail.current).map((id) => byIdAll.get(id)).filter(Boolean);
  const railIndex = openOffer ? railRows.findIndex((o) => o.id === openId) : -1;
  const neighbor = (dir) => railStep(railRows, openId, dir);
  const goTo = (id) => { if (id) { setOpenId(id); writeOfferParam(id); } };
  const closeSplit = () => {
    if (openOffer) openGroup(groupKeyOf(openOffer));
    setClosedId(openId); setOpenId(null); setRailIds(null); writeOfferParam(null);
  };
  splitNav.current = openOffer ? {
    go: (dir) => goTo(neighbor(dir)),
    close: closeSplit,
    blocked: Boolean(selected || sending || psaing || contracting || assigning || netSheeting || enriching || offerPaging),
  } : null;
  // Arrowing to another agent's offer opens their group underneath, so closing
  // the popout leaves you looking at the row you stopped on.
  const stepTo = (o) => { openGroup(groupKeyOf(o)); openDetail(o); };

  // The windows the table and the split share (Details, Send, the generators).
  const modals = (
    <>
      {selected && (() => {
        // The agent's other offers, in the same newest-first order the table
        // shows — unfiltered, because the popout is where you go to see the
        // whole relationship, not the slice the current chip left standing.
        // These are lean rows: the rail only shows address, date and status,
        // and picking one re-enters through openDetail, which hydrates it.
        const key = groupKeyOf(selected);
        const siblings = annotateCurrent(offers).filter((o) => groupKeyOf(o) === key);
        // The frozen queue, re-read off the live list so a status recorded in
        // the popout shows on the row you'll arrow back to. A deleted offer
        // simply falls out.
        const byId = new Map(offers.map((o) => [o.id, o]));
        const queue = (queueIds || []).map((id) => byId.get(id)).filter(Boolean);
        return (
          <OfferDetailModal offer={selected} siblings={siblings}
            queue={queue.length > 1 ? queue : null}
            queueLabel={activeFilter.key === "all" ? "" : activeFilter.label}
            onSelect={stepTo}
            onClose={closeDetail}
            onEdit={(o) => { closeDetail(); onEdit?.(o); }}
            onSend={(o) => setSending(o)}
            onPsa={openPsa}
            onContract={openContract}
            onAssignment={openAssignment}
            onNetSheet={openNetSheet}
            onOfferPage={(o) => setOfferPaging(o)}
            onPromote={(o) => { closeDetail(); promote(o); }}
            onStatus={changeStatus}
            onRequote={requote} requoting={requoting}
            statusBusy={statusBusy === selected.id}
            onDealNav={onDeal} />
        );
      })()}
      {sending && <SendModal offer={sending} onClose={() => setSending(null)} onSent={handleSent} />}
      {offerPaging && <OfferPageModal offer={offerPaging} onClose={() => setOfferPaging(null)} />}
      {enriching && <EnrichModal contactId={enriching.contactId} contactName={enriching.contactName}
        defaultType="agent" onClose={() => setEnriching(null)} />}
      {psaing && <PsaModal offer={psaing} settings={settings}
        onClose={() => setPsaing(null)} onGenerated={patchOffer} />}
      {contracting && <ContractModal offer={contracting} settings={settings}
        onClose={() => setContracting(null)} onGenerated={patchOffer} />}
      {assigning && <AssignmentModal offer={assigning} settings={settings}
        onClose={() => setAssigning(null)} onGenerated={patchOffer} />}
      {netSheeting && <NetSheetModal offer={netSheeting} settings={settings}
        onClose={() => setNetSheeting(null)} onGenerated={patchOffer} />}
    </>
  );

  /* ---------- the split: the rail and the open offer ---------- */
  if (openOffer) {
    // Below laptop width the rail is a picker in the pane's header.
    const picker = (
      <select className="max-w-[10rem] rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs lg:hidden" aria-label="Pick an offer"
        value={openId} onChange={(e) => goTo(e.target.value)}>
        {railRows.map((o) => <option key={o.id} value={o.id}>{String(o.address || "Untitled").split(",")[0]} — {o.contactName || "No contact"}</option>)}
      </select>
    );
    const prevId = neighbor(-1);
    const nextId = neighbor(1);
    return (
      <>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} onClick={closeSplit} title="Back to the table (Esc)"><ChevronLeft size={13} aria-hidden="true" /> Table</button>
          <FilterChips value={view} onChange={setFilter} options={chips} label="Filter offers by status" />
          {otherMenu}
          <SearchInput value={q} onChange={setQ} className="ml-auto min-w-[16rem] flex-1 sm:max-w-sm"
            placeholder="Search by contact, address, amount, or date…" label="Search offers" />
        </div>
        {error && <div className="mb-3"><ErrorBar>{error}</ErrorBar></div>}
        <div className="relative flex min-h-[560px] gap-3 lg:h-[calc(100vh-11rem)]">
          <div className="hidden w-80 shrink-0 lg:block">
            <OfferRail rows={railRows} selectedId={openId} onSelect={goTo} label={activeFilter.key === "all" ? "All offers" : activeFilter.label} />
          </div>
          <OfferPane key={openId} offer={openOffer} index={railIndex} total={railRows.length}
            onPrev={prevId ? () => goTo(prevId) : null} onNext={nextId ? () => goTo(nextId) : null}
            onClose={closeSplit} onDetails={(o) => openDetail(o)} onSend={(o) => setSending(o)}
            onChanged={(o) => refreshContact(o?.contactId)}
            onStatusChanged={(r) => { if (r?.offer) patchOffer(r.offer); if (r?.promoted) onDeal?.(); }}
            onDeal={onDeal} settings={appSettings || settings} picker={picker} />
        </div>
        {modals}
      </>
    );
  }

  return (
    <>
      {/* Runs kicked off by a GHL workflow when an agent texts in. Renders
          nothing when none are live or waiting on a human. */}
      <UnderwriteStrip onReview={(offerId) => openEdit({ id: offerId })} />

      <div className="mb-3">
        <KpiRow items={kpis} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterChips value={view} onChange={setFilter} options={chips} label="Filter offers by status" />
        {otherMenu}
        <SearchInput value={q} onChange={setQ} className="ml-auto min-w-[16rem] flex-1 sm:max-w-sm"
          placeholder="Search by contact, address, amount, or date…" label="Search offers" />
      </div>

      {error && <div className="mb-3"><ErrorBar>{error}</ErrorBar></div>}

      {picked.size > 0 && (
        <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
          <span className="text-sm font-semibold">{picked.size} selected</span>
          <span className="text-xs text-slate-400">Record the same outcome on all of them</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" className={BTN} disabled={bulkBusy} onClick={() => bulkStatus("sent")}>Mark sent</button>
            <button type="button" className={BTN} disabled={bulkBusy} onClick={() => bulkStatus("countered")}>Mark countered</button>
            <button type="button" className={BTN} disabled={bulkBusy} onClick={() => bulkStatus("no_response")}>Mark no response</button>
            <button type="button" className={BTN} disabled={bulkBusy} onClick={() => bulkStatus("passed")}>They passed</button>
            <button type="button" className={BTN} disabled={bulkBusy} onClick={() => bulkStatus("we_passed")}>We passed</button>
            <button type="button" className={BTN} disabled={bulkBusy} onClick={() => bulkStatus("unavailable")}>No longer available</button>
            <button type="button" className={BTN_ICON} onClick={() => setPicked(new Set())} aria-label="Clear selection">
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState action={<button type="button" className={BTN_PRIMARY} onClick={clearFilters}>Clear filters</button>}>
          {needle ? `No offers match "${q.trim()}"` : "Nothing in this view"}
          {view !== "all" && needle ? ` in ${activeFilter.label.toLowerCase()}` : ""}.
        </EmptyState>
      ) : (
      <TableCard>
        {/* min-w scrolls the card rather than crushing columns on narrow
            screens; the document links wrap (below) rather than run under the
            opaque sticky action cell when the table is merely tight. */}
        <table className="w-full min-w-[80rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-3 py-2.5">
                <input type="checkbox" checked={allPicked} onChange={toggleAll}
                  disabled={!selectable.length} aria-label="Select all shown offers" />
              </th>
              <SortHeader label="Agent" sortKey="agent" sort={sort} onSort={toggleSort} naturalDir={SORTS.agent.natural} />
              <SortHeader label="Date" sortKey="date" sort={sort} onSort={toggleSort} naturalDir={SORTS.date.natural} />
              <SortHeader label="Property" sortKey="property" sort={sort} onSort={toggleSort} naturalDir={SORTS.property.natural} />
              <SortHeader label="Cash offer" sortKey="cash" sort={sort} onSort={toggleSort} naturalDir={SORTS.cash.natural} align="right" />
              <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} naturalDir={SORTS.status.natural} />
              {/* After Status, not beside Date: next to the offer's own date it
                  would read as another property of the offer rather than of
                  the agent. */}
              <SortHeader label="Last activity" sortKey="activity" sort={sort} onSort={toggleSort} naturalDir={SORTS.activity.natural} />
              <SortHeader label="Next follow-up" sortKey="next" sort={sort} onSort={toggleSort} naturalDir={SORTS.next.natural} />
              <th scope="col" className="w-44 px-4 py-2.5">Document</th>
              <th scope="col" className="sticky right-0 bg-white px-4 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isOpen = needle ? true : autoOpen ? !expanded.has(g.key) : expanded.has(g.key);
              // The offer that put this agent where they are in the list —
              // their newest by default, their priciest when you sort by cash.
              const lead = g.offers[0];
              const addresses = [...new Set(g.offers.map((o) => o.address).filter(Boolean))];
              // A collapsed group would otherwise hide the whole point of the
              // AI queue: you'd click the chip, see agent names, and have to
              // open each one to find which offer is waiting on you.
              const aiPending = g.offers.filter(needsAiReview).length;
              return (
                <React.Fragment key={g.key}>
                  <tr {...rowActivation(() => toggleGroup(g.key))}
                    aria-expanded={isOpen}
                    aria-label={`${g.contactName || "No contact"}, ${g.offers.length} offer${g.offers.length === 1 ? "" : "s"}`}
                    className="group cursor-pointer border-b border-slate-100 bg-slate-50/60 last:border-0 hover:bg-slate-100">
                    <td className="px-3 py-2.5" />
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        {isOpen ? <ChevronDown size={15} className="text-slate-400" aria-hidden="true" /> : <ChevronRight size={15} className="text-slate-400" aria-hidden="true" />}
                        {g.contactId ? (
                          <ContactLink contactId={g.contactId} name={g.contactName || g.contactId} party="agent" className="font-semibold" stopPropagation>
                            {g.contactName || g.contactId}
                          </ContactLink>
                        ) : (
                          <span className="font-semibold">{g.contactName || "No contact"}</span>
                        )}
                        {aiPending > 0 && (
                          <span
                            className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800"
                            title={`${aiPending} auto-underwritten offer${aiPending === 1 ? "" : "s"} nobody has acted on yet`}>
                            {aiPending} AI
                          </span>
                        )}
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                          {g.offers.length} offer{g.offers.length === 1 ? "" : "s"}
                        </span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">
                      {(lead.createdAt || "").slice(0, 10)}
                    </td>
                    <td className="max-w-[22rem] truncate px-4 py-2.5 text-slate-600"
                      title={addresses.length === 1 ? addresses[0] : undefined}>
                      {addresses.length === 1 ? addresses[0] : addresses.length ? `${addresses.length} properties` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums">
                      {lead.cashAmount != null ? fmtMoney(lead.cashAmount) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <StatusDots offers={g.offers} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <ActivityStamp activity={groupActivity(g.offers)} enriched={g.offers.some((o) => o.lastActivity !== undefined)} />
                    </td>
                    <td className="px-4 py-2.5">
                      <NextFollowUp next={groupNext(g.offers)} enriched={g.offers.some((o) => o.nextFollowUp !== undefined)} />
                    </td>
                    <td className="px-4 py-2.5" />
                    <td className="sticky right-0 whitespace-nowrap bg-slate-50/60 px-4 py-2.5 text-right group-hover:bg-slate-100"
                      onClick={(e) => e.stopPropagation()}>
                      {g.contactId && (
                        <button type="button"
                          onClick={() => setEnriching({ contactId: g.contactId, contactName: g.contactName })}
                          className={`${BTN_ICON} text-amber-500 hover:bg-amber-50 hover:text-amber-600`}
                          aria-label={`AI enrichment for ${g.contactName || "this contact"}`}
                          title="AI enrichment — summarize the conversation and fill CRM fields">
                          <Sparkles size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                  {isOpen && byHouse(g.offers).map((o) => {
                    const draft = o.status === "draft";
                    const old = Boolean(o.supersededBy);
                    return (
              <tr key={o.id}
                {...rowActivation(() => (draft ? openEdit(o) : openSplit(o)))}
                data-offer-row={o.id}
                aria-label={`${o.address || "Offer"} — ${OFFER_STATUS[effectiveStatus(o)]?.label || ""}`}
                aria-busy={opening === o.id || undefined}
                className={`group cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 ${
                  picked.has(o.id) ? "bg-blue-50/60" : ""} ${opening === o.id || old ? "opacity-60" : ""}`}>
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  {!draft && !o.deal && (
                    <input type="checkbox" checked={picked.has(o.id)} onChange={() => togglePick(o.id)}
                      aria-label={`Select the offer on ${o.address || "this property"}`} />
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <span className="ml-5 block border-l-2 border-slate-200 pl-3 text-[11px] uppercase tracking-wide text-slate-400">
                    {" "}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">
                  {(o.createdAt || "").slice(0, 10)}
                </td>
                <td className="max-w-[20rem] px-4 py-2.5">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate" title={o.address || undefined}>{o.address || "—"}</span>
                    <AiPill offer={o} />
                    {normalizeAsset(o.asset) && normalizeAsset(o.asset).type !== "sfr" && (
                      <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-900">{assetLabel(o.asset)}</span>
                    )}
                  </span>
                  {old && (
                    <span className="block text-[11px] text-slate-400">
                      superseded by {fmtMoney(o.supersededBy.cashAmount)} · {(o.supersededBy.at || "").slice(5, 10)}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums">
                  {o.cashAmount != null ? fmtMoney(o.cashAmount) : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  {draft ? (
                    <StatusPill offer={o} small />
                  ) : (
                    <StatusMenu offer={o} busy={statusBusy === o.id}
                      onSelect={(s) => changeStatus(o, s)} onDealNav={onDeal} />
                  )}
                  <AttachWarning offer={o} />
                  <SentBadge offer={o} />
                  {!draft && !o.deal && !old && effectiveStatus(o) === "new" && (
                    <span className={`ml-1.5 whitespace-nowrap text-[11px] ${o.floatedAt ? "text-amber-700" : "text-slate-400"}`}
                      title={o.floatedAt ? "Our number went out by text — the written offer hasn't" : "Priced, never floated or sent"}>
                      {notSentAge(o)}
                    </span>
                  )}
                </td>
                {/* Muted on the child rows: it is a fact about the agent,
                    inherited by every offer of theirs, not about this house. */}
                <td className="whitespace-nowrap px-4 py-2.5">
                  <ActivityStamp activity={o.lastActivity} enriched={o.lastActivity !== undefined} muted />
                </td>
                <td className="px-4 py-2.5">
                  <NextFollowUp next={o.nextFollowUp} enriched={o.nextFollowUp !== undefined} muted={old} />
                </td>
                <td className="w-44 px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  {/* shrink-0 on the links: flex items shrink before they wrap,
                      which clips a label mid-word instead of moving it down. */}
                  <span className="flex flex-wrap gap-x-2 text-slate-600 [&>a]:shrink-0">
                    {o.pdfUrl && (
                      <a href={o.pdfUrl} target="_blank" rel="noreferrer" className="underline hover:text-slate-900">PDF</a>
                    )}
                    {o.scopePdfUrl && (
                      <a href={o.scopePdfUrl} target="_blank" rel="noreferrer" className="underline hover:text-slate-900">SOW</a>
                    )}
                    {o.compsPdfUrl && (
                      <a href={o.compsPdfUrl} target="_blank" rel="noreferrer" className="underline hover:text-slate-900">Comps</a>
                    )}
                    {o.imageUrl && (
                      <a href={o.imageUrl} target="_blank" rel="noreferrer" className="underline hover:text-slate-900">Image</a>
                    )}
                    {o.contractPdfUrl && (
                      <a href={o.contractPdfUrl} target="_blank" rel="noreferrer" className="underline hover:text-slate-900">Contract</a>
                    )}
                    {o.assignmentPdfUrl && (
                      <a href={o.assignmentPdfUrl} target="_blank" rel="noreferrer" className="underline hover:text-slate-900">Assignment</a>
                    )}
                  </span>
                </td>
                <td className="sticky right-0 whitespace-nowrap bg-white px-4 py-2.5 text-right group-hover:bg-slate-50" onClick={(e) => e.stopPropagation()}>
                  {!draft && o.contactId && (
                    <button type="button" onClick={() => setSending(o)} className={`${BTN} mr-1`}
                      title="Text or email the offer documents">
                      <Send size={13} aria-hidden="true" /> Send
                    </button>
                  )}
                  <button type="button" onClick={() => openEdit(o)} className={`${BTN} mr-1`}
                    disabled={opening === o.id}
                    title={draft ? "Continue editing draft" : "Open this offer to revise and save it"}>
                    <Pencil size={13} aria-hidden="true" /> Edit
                  </button>
                  <button type="button" onClick={() => remove(o)} className={BTN_ICON}
                    aria-label={`Delete the offer on ${o.address || "this property"}`} title="Delete">
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </TableCard>
      )}
      {modals}
    </>
  );
}
