// OffersHistory.jsx — the landing view: every offer created for this location,
// grouped by agent (contact), with its outcome. One collapsible row per agent,
// individual offers nested under it. The contact links to the GHL contact
// record; clicking an offer row opens the full offer detail.
//
// This is where the day is worked, so the table is organized around the one
// question that matters at 10 offers a day: which of these is still alive?
// Hence the status column (a control, not a label — you set an outcome from
// the row itself), the filter chips that answer it in one tap, and the KPI
// strip that turns 120-offers-to-1-contract into numbers you can watch.
//
// Status lives in shared/offer-status.js; nothing here decides what a status
// means, only how it looks and how you change it.

import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Pencil, Send, Sparkles, Trash2, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import {
  DEAD_STATUSES, OFFER_STATUS, OFFER_STATUS_KEYS, effectiveStatus, isAiGenerated, needsAiReview,
  toListOffer,
} from "@shared/offer-status.js";
import {
  deleteOffer, getOffer, getSettings, ghlContactUrl, listOffers, promoteDeal,
  setOfferStatus, setOfferStatusBulk,
} from "./api.js";
import SendModal, { CHANNEL_LABELS } from "./SendModal.jsx";
import ContractModal from "./ContractModal.jsx";
import PsaModal from "./PsaModal.jsx";
import AssignmentModal from "./AssignmentModal.jsx";
import NetSheetModal from "./NetSheetModal.jsx";
import EnrichModal from "./EnrichModal.jsx";
import OfferPageModal from "./OfferPageModal.jsx";
import OfferDetailModal from "./OfferDetailModal.jsx";
import UnderwriteStrip from "./UnderwriteStrip.jsx";
import {
  AiPill, AttachWarning, BTN, BTN_ICON, BTN_PRIMARY, EmptyState, ErrorBar, FilterChips, KpiRow,
  SearchInput, SkeletonRows, SortHeader, StatusDots, StatusMenu, StatusPill, TableCard,
  compareBy, rowActivation, useSort,
} from "./ui.jsx";

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

/* ---------- filters ---------- */

// Each chip is one question you actually ask the list. `test` runs against a
// single offer; counts come from running them over the search-filtered set, so
// a chip's number always matches what clicking it shows.
const FILTERS = [
  { key: "all", label: "All", test: () => true },
  { key: "unsent", label: "Not sent", test: (o) => !o.deal && effectiveStatus(o) === "new" && o.status !== "draft" },
  { key: "waiting", label: "Awaiting reply", test: (o) => !o.deal && effectiveStatus(o) === "sent" },
  { key: "countered", label: "Countered", test: (o) => !o.deal && effectiveStatus(o) === "countered" },
  { key: "dead", label: "Passed / no reply", test: (o) => !o.deal && DEAD_STATUSES.has(effectiveStatus(o)) },
  { key: "deals", label: "Deals", test: (o) => Boolean(o.deal) },
  { key: "drafts", label: "Drafts", test: (o) => o.status === "draft" },
  // A different axis from the six above — those ask where an offer is in the
  // funnel, this asks who made it and whether anyone has looked. It sits last
  // and wears its own colour so it doesn't read as another funnel state, and
  // it is hidden entirely for locations that never run the automation.
  {
    key: "ai",
    label: "AI review",
    tone: "ai",
    title: "Auto-underwritten offers nobody has acted on yet — held drafts, and offers built but not sent",
    test: needsAiReview,
    onlyWhenUsed: true,
  },
];

/* ---------- sorting ---------- */

// What each sortable column reads off a row, and which way round it should
// start. Dates and money open on the biggest/most recent, because that is the
// question being asked when you click them; names open A→Z.
//
// Status sorts by FUNNEL POSITION, not alphabetically: draft → not sent → sent
// → countered → no response → passed → accepted. "Countered" landing between
// "sent" and "passed" is the useful order; landing next to "draft" because
// both start with a letter near C is not.
const SORTS = {
  agent: { natural: "asc", of: (o) => o.contactName || "" },
  date: { natural: "desc", of: (o) => o.createdAt || "" },
  property: { natural: "asc", of: (o) => o.address || "" },
  cash: { natural: "desc", of: (o) => (o.cashAmount != null ? Number(o.cashAmount) : null) },
  status: { natural: "asc", of: (o) => OFFER_STATUS_KEYS.indexOf(effectiveStatus(o)) },
};

// One agent, one group. Offers with no contact record still collapse together
// by name, and everything nameless lands in one bucket rather than one group
// each.
const groupKeyOf = (o) => o.contactId || (o.contactName ? `name:${o.contactName}` : "none");

const LIVE_STAGES = new Set(["under_contract", "buyer_found", "assigned"]);

export default function OffersHistory({ onEdit, onDeal }) {
  const [offers, setOffers] = useState(null);
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
  const [filter, setFilter] = useState("waiting"); // open on the offers you're owed a reply on
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
    listOffers({ limit: 2000, lean: true })
      .then(setOffers)
      .catch((e) => setError(e.message));
  }, []);

  // The selection describes the CURRENT view — narrowing it must never leave
  // hidden rows in the batch, or "mark 12 passed" quietly touches rows you
  // can't see. Same rule Agent Outreach uses.
  useEffect(() => { setPicked(new Set()); }, [q, filter]);

  // One patcher for every copy of an offer we're holding. The table keeps the
  // lean row it was loaded with; whatever is open keeps the whole document.
  function patchOffer(updated) {
    if (!updated) return;
    const patch = (o) => (o && o.id === updated.id ? updated : o);
    setOffers((list) => (list || []).map((o) => (o.id === updated.id ? toListOffer(updated) : o)));
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
      patchOffer(r.offer);
      // Promotion navigates to the Deals tab — leaving the popout open over it
      // would strand you on top of the thing you just landed on.
      if (r.promoted) { closeDetail(); onDeal?.(); }
    } catch (e) { setError(e.message); }
    setStatusBusy(null);
  }

  async function bulkStatus(status) {
    const ids = [...picked];
    if (!ids.length || bulkBusy) return;
    setBulkBusy(true);
    setError("");
    try {
      const r = await setOfferStatusBulk(ids, status);
      const byId = new Map((r.offers || []).map((o) => [o.id, toListOffer(o)]));
      setOffers((list) => (list || []).map((o) => byId.get(o.id) || o));
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

  const needle = q.trim().toLowerCase();
  const searched = !needle
    ? offers
    : offers.filter((o) =>
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

  const usesAi = offers.some(isAiGenerated);
  const chips = FILTERS
    .filter((f) => !f.onlyWhenUsed || usesAi)
    .map((f) => ({
      key: f.key, label: f.label, tone: f.tone, title: f.title,
      count: searched.filter(f.test).length,
    }));
  const activeFilter = FILTERS.find((f) => f.key === filter) || FILTERS[0];
  // Sorted BEFORE grouping, which is what makes the groups follow the sort:
  // an agent lands wherever their leading offer lands, exactly as they used to
  // land by their most recent one (see the grouping note below).
  const shown = searched
    .filter(activeFilter.test)
    .slice()
    .sort(compareBy(sort.key, sort.dir, (o, key) => (SORTS[key] || SORTS.date).of(o)));

  // KPIs run over every offer for the location, not the filtered view — they're
  // the state of the business, not of the current query.
  const real = offers.filter((o) => o.status !== "draft");
  const monthAgo = Date.now() - 30 * 86400000;
  const recent = real.filter((o) => new Date(o.createdAt || 0).getTime() >= monthAgo).length;
  const waiting = real.filter((o) => !o.deal && effectiveStatus(o) === "sent").length;
  // Reply rate: of everything that actually went out, how much came back with
  // an answer of any kind. "No response" is a non-reply, so it sits in the
  // denominator only — which is the point of tracking it separately.
  const delivered = real.filter((o) => effectiveStatus(o) !== "new").length;
  const replied = real.filter((o) => ["countered", "passed", "accepted"].includes(effectiveStatus(o))).length;
  const liveDeals = real.filter((o) => o.deal && LIVE_STAGES.has(o.deal.stage)).length;
  const kpis = [
    { label: "Offers (30d)", value: recent, hint: "Non-draft offers created in the last 30 days" },
    { label: "Awaiting reply", value: waiting, hint: "Sent, no outcome recorded yet" },
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

  // Opening a row hands the popout the list it came out of, in the order the
  // table is showing it, so its arrows walk the filter you are working. It is
  // FROZEN at open: recording an outcome from inside the popout drops that
  // offer out of "Awaiting reply", and a queue that re-derived itself would
  // renumber under you and skip the row you were about to reach.
  const rowsInOrder = groups.flatMap((g) => g.offers);
  const openRow = (o) => { setQueueIds(rowsInOrder.map((x) => x.id)); openDetail(o); };
  const closeDetail = () => { setSelected(null); setQueueIds(null); };
  // Arrowing to another agent's offer opens their group underneath, so closing
  // the popout leaves you looking at the row you stopped on.
  const stepTo = (o) => { setExpanded((prev) => new Set(prev).add(groupKeyOf(o))); openDetail(o); };

  return (
    <>
      {/* Runs kicked off by a GHL workflow when an agent texts in. Renders
          nothing when none are live or waiting on a human. */}
      <UnderwriteStrip onReview={(offerId) => openEdit({ id: offerId })} />

      <div className="mb-3">
        <KpiRow items={kpis} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterChips value={filter} onChange={setFilter} options={chips} label="Filter offers by status" />
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
            <button type="button" className={BTN} disabled={bulkBusy} onClick={() => bulkStatus("passed")}>Mark passed</button>
            <button type="button" className={BTN_ICON} onClick={() => setPicked(new Set())} aria-label="Clear selection">
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState action={<button type="button" className={BTN_PRIMARY} onClick={clearFilters}>Clear filters</button>}>
          {needle ? `No offers match "${q.trim()}"` : "Nothing in this view"}
          {filter !== "all" && needle ? ` in ${activeFilter.label.toLowerCase()}` : ""}.
        </EmptyState>
      ) : (
      <TableCard>
        {/* min-w scrolls the card rather than crushing columns on narrow
            screens; the document links wrap (below) rather than run under the
            opaque sticky action cell when the table is merely tight. */}
        <table className="w-full min-w-[64rem] text-sm">
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
              <th scope="col" className="w-44 px-4 py-2.5">Document</th>
              <th scope="col" className="sticky right-0 bg-white px-4 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isOpen = needle ? true : expanded.has(g.key);
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
                          <a href={ghlContactUrl(g.contactId)} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 font-semibold underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
                            title="Open contact in GHL">
                            {g.contactName || g.contactId} <ExternalLink size={12} className="text-slate-400" aria-hidden="true" />
                          </a>
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
                  {isOpen && g.offers.map((o) => {
                    const draft = o.status === "draft";
                    return (
              <tr key={o.id}
                {...rowActivation(() => (draft ? openEdit(o) : openRow(o)))}
                aria-label={`${o.address || "Offer"} — ${OFFER_STATUS[effectiveStatus(o)]?.label || ""}`}
                aria-busy={opening === o.id || undefined}
                className={`group cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 ${
                  picked.has(o.id) ? "bg-blue-50/60" : ""} ${opening === o.id ? "opacity-60" : ""}`}>
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
                  </span>
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
      {selected && (() => {
        // The agent's other offers, in the same newest-first order the table
        // shows — unfiltered, because the popout is where you go to see the
        // whole relationship, not the slice the current chip left standing.
        // These are lean rows: the rail only shows address, date and status,
        // and picking one re-enters through openDetail, which hydrates it.
        const key = groupKeyOf(selected);
        const siblings = offers.filter((o) => groupKeyOf(o) === key);
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
}
