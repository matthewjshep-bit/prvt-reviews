// NewOffer.jsx — the core flow: contact → property numbers → three live
// offers → generate the document and attach everything to the GHL contact.
//
// It saves as you type (offer-autosave.js, 2026-10-23): one row per house, a
// draft until Send turns it into the offer on the same row, and from then on
// the letter follows what you type. Send and the Status menu are the verbs.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, ChevronDown, ChevronUp, ExternalLink, FileSignature, FileText, Layers, Link2, Loader2, Maximize2, Plus, RotateCcw, Save, Search, Send, Sparkles, Trash2, X } from "lucide-react";
import { calculateOffers, DEFAULT_OFFER_SETTINGS, fmtMoney, UNDERWRITE_MODES } from "@shared/offer-calc.js";
import { buyerCeiling } from "@shared/post-mortem.js";
import { checksFor, combineChecks, checksLines } from "@shared/underwrite-checks.js";
import { ASSET_TYPE_LABELS, MH_LAND, MH_LAND_LABELS, assetFromHomeType } from "@shared/asset-type.js";
import { buildUnderwriteCalc, modelForAsset, runUnderwrite as runAnalyzer } from "@shared/underwrite-model.js";
import { blankIncomeDeal } from "@shared/income-underwrite.js";
import { blankLandDeal } from "@shared/land-underwrite.js";
import {
  addContactNote, cancelUnderwrite, getContactDetail, getContactNotes, getOffer, getUnderwrite,
  ghlContactUrl, listDatarooms, listOffers, previewDocument, promoteDeal, publishOffer, runUnderwrite, saveDraft,
  saveOfferWorkspace, saveSettings, searchContacts, setOfferStatus, suggestAddresses, updateDataroom,
  updateOffer, zillowUrl,
  requoteOffer, MAKE_CURRENT,
} from "./api.js";
import { LIVE as UW_LIVE, PHASE as UW_PHASE } from "./UnderwriteStrip.jsx";
import CompsPane from "./CompsPane.jsx";
import RehabPane from "./RehabPane.jsx";
import IncomeUnderwriter from "./IncomeUnderwriter.jsx";
import LandUnderwriter from "./LandUnderwriter.jsx";
import NotesPanel from "./NotesPanel.jsx";
import SendModal, { CHANNEL_LABELS } from "./SendModal.jsx";
import ContractModal from "./ContractModal.jsx";
import PsaModal from "./PsaModal.jsx";
import AssignmentModal from "./AssignmentModal.jsx";
import NetSheetModal from "./NetSheetModal.jsx";
import EnrichModal from "./EnrichModal.jsx";
import OfferPageModal from "./OfferPageModal.jsx";
import OfferDetailModal from "./OfferDetailModal.jsx";
import { CurrentPill, PaperHeldBanner, StatusMenu, StatusPill } from "./ui.jsx";
import { annotateCurrent, houseKey, rowOnHouse } from "@shared/current-offer.js";
import { DRAFT_DELAY_MS, createAutosaver, hasPaper, namesAHouse, saveKindFor } from "./offer-autosave.js";
import { onOfferChanged } from "./offer-sync.js";

// Pick the best address from a contact's custom fields: prefer a
// "…address…short…" key (the Property Address Short Hand field), then any
// property-address field, then anything address-like.
function pickContactAddress(custom) {
  const score = (k) => {
    const n = k.toLowerCase().replace(/[^a-z]/g, "");
    if (n.includes("address") && n.includes("short")) return 3;
    if (n.includes("property") && n.includes("address")) return 2;
    if (n.includes("address")) return 1;
    return 0;
  };
  let best = "", bestScore = 0;
  for (const [k, v] of Object.entries(custom || {})) {
    const val = String(v || "").trim();
    if (!val) continue;
    const s = score(k);
    if (s > bestScore) { bestScore = s; best = val; }
  }
  return best;
}

// Address input with debounced suggestions (broker-proxied geocoder).
function AddressInput({ value, onChange, placeholder }) {
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const skipNext = useRef(false);

  useEffect(() => {
    clearTimeout(timer.current);
    if (skipNext.current) { skipNext.current = false; return; }
    if (!open || value.trim().length < 5) { setOptions([]); return; }
    timer.current = setTimeout(() => {
      suggestAddresses(value.trim()).then((s) => setOptions(s || [])).catch(() => setOptions([]));
    }, 350);
    return () => clearTimeout(timer.current);
  }, [value, open]);

  return (
    <div className="relative">
      <input
        className={INPUT_CLS}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { setOpen(true); onChange(e.target.value); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        autoComplete="off"
      />
      {open && options.length > 0 && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { skipNext.current = true; onChange(o); setOptions([]); setOpen(false); }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

// The property-type control, in the order they're reached for. A house is
// priced by comps; multi-family and commercial by income; land by the acre
// (shared/underwrite-model.js). Mobile stays pickable for the ones we hold.
const TYPE_CHOICES = [
  { type: "sfr", label: "Single family" },
  { type: "multi_family", label: "Multi-family" },
  { type: "commercial", label: "Commercial" },
  { type: "land", label: "Land" },
  { type: "manufactured", label: "Mobile" },
];
const MODEL_WORDS = { comps: "comps & rehab", income: "income", land: "land value" };
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

// The Auto-underwrite button: the same robot the GHL workflow fires, pointed
// at the address in the form — and its answer lands IN this form. It runs in
// the background on the broker (two to five minutes, the listing scrapes
// dominate), so the button turns into a status row that polls the job, and
// when the run lands the workspace it built — comps, grades, ARV, the photo
// scope, repairs — is taken into the open form. No second offer, no draft:
// the record it belongs to is the one on screen, and Create/Save is still
// yours to press.
//
// It needs an EXISTING contact: the run reads the listing for their record
// and files its notes there, and a contact that doesn't exist yet has none.
const UW_POLL_MS = 4000;

function AutoUnderwrite({ contactId, address, askingPrice, onApply, declined }) {
  const [job, setJob] = useState(null);     // the polled job, once started
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(false);
  const timer = useRef(null);

  // Poll while the job is live; stop when it lands.
  useEffect(() => {
    if (!job?.id || !UW_LIVE.has(job.status)) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const j = await getUnderwrite(job.id);
        if (!alive) return;
        if (j) setJob(j);
      } catch { /* a blip; the next tick tries again */ }
      if (alive) timer.current = setTimeout(tick, UW_POLL_MS);
    };
    timer.current = setTimeout(tick, UW_POLL_MS);
    return () => { alive = false; clearTimeout(timer.current); };
  }, [job?.id, job?.status]);

  // The moment the numbers are back they go into the form. Once, not on
  // every poll, and never over a workspace the operator has since replaced.
  useEffect(() => {
    if (applied || job?.status !== "done" || !job.snapshot) return;
    setApplied(true);
    onApply?.(job.snapshot);
  }, [job?.status, job?.snapshot, applied, onApply]);

  const ready = Boolean(contactId) && Boolean(String(address || "").trim());
  const why = !contactId ? "Pick an existing contact first — the run reads the listing for their record"
    : !String(address || "").trim() ? "Type the property address first" : "";

  async function start() {
    setError("");
    setStarting(true);
    setApplied(false);
    try {
      const r = await runUnderwrite({ contactId, address: address.trim(), askingPrice: askingPrice || 0, declined: declined?.() || null });
      setJob({ id: r.jobId, status: "queued", phase: "queued", startedAt: new Date().toISOString() });
    } catch (e) {
      setError(e.message || "Couldn't start the underwrite.");
    } finally { setStarting(false); }
  }

  const live = job && UW_LIVE.has(job.status);
  const btn = "inline-flex items-center gap-1.5 rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50";

  if (!job) {
    return (
      <div className="mt-2">
        <button type="button" className={btn} disabled={!ready || starting} title={why || "Pull comps, grade them, scan the listing photos and fill in ARV, repairs and the scope below — 2 to 5 minutes"} onClick={start}>
          {starting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          Auto-underwrite this address
        </button>
        {why && <span className="ml-2 text-[11px] text-slate-400">{why}</span>}
        {error && <div className="mt-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</div>}
      </div>
    );
  }

  const flagged = job.status === "done" && (job.held || []).length > 0;
  return (
    <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
      live ? "border-violet-200 bg-violet-50/60"
      : job.status === "done" ? (flagged ? "border-amber-300 bg-amber-50" : "border-emerald-200 bg-emerald-50/60")
      : "border-red-200 bg-red-50"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {live ? <Loader2 size={13} className="animate-spin text-violet-700" />
          : job.status === "done" ? (flagged ? <AlertTriangle size={13} className="text-amber-700" /> : <Check size={13} className="text-emerald-700" />)
          : <AlertTriangle size={13} className="text-red-700" />}
        <span className="font-semibold text-slate-800">
          {live ? (UW_PHASE[job.phase] || "Working") + "…"
            : job.status === "done" ? (flagged ? "Filled in, with flags" : "Filled in")
            : job.status === "held" ? "Stopped" : "Didn't finish"}
        </span>
        {job.status === "done" && (
          <span className="text-slate-600">
            ARV {fmtMoney(job.arv || 0)} · repairs {fmtMoney(job.repairs || 0)}
            {job.compsUsed?.length ? ` · ${job.compsUsed.length} comps` : ""}
            {job.photosAnalyzed ? ` · ${job.photosAnalyzed} photos` : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {live && (
            <button type="button" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50" disabled={job.stopping}
              onClick={() => cancelUnderwrite(job.id).catch(() => {})}>
              {job.stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          {!live && (
            <button type="button" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50" onClick={() => { setJob(null); setError(""); }}>
              {job.status === "done" ? "Done" : "Try again"}
            </button>
          )}
        </span>
      </div>
      {(job.held || []).length > 0 && (
        <ul className="mt-1 list-inside list-disc text-amber-900">{job.held.map((h, i) => <li key={i}>{h}</li>)}</ul>
      )}
      {job.status === "done" && checksLines(job.checks).length > 0 && (
        <ul className="mt-1 list-inside list-disc text-sky-900" data-testid="fill-checks">
          {checksLines(job.checks).map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
      {job.status === "done" && !flagged && (
        <div className="mt-1 text-slate-500">The comps, the grades and the photo scope are in the panes below. Check them, then create the offer.</div>
      )}
      {job.status === "error" && job.error && <div className="mt-1 text-red-700">{job.error}</div>}
      {error && <div className="mt-1 text-red-700">{error}</div>}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <span className={LABEL_CLS}>{label}</span>
      {children}
    </div>
  );
}

/* ---------------- this agent's other offers ---------------- */

// A strip of every offer this agent has, above the form. Clicking one opens
// the offer window rather than loading it into the editor: mid-underwrite you
// want to LOOK at what else is open with them, and swapping the form out from
// under you would be a trap. The window's own "Edit offer" is the deliberate
// way to switch.
function AgentOfferTabs({ offers, currentId, contactName, onOpen }) {
  if (!offers.length) return null;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        <Layers size={13} className="mr-1 inline align-[-2px]" />
        {contactName ? `${contactName.split(" ")[0]}'s offers` : "Agent's offers"}
        <span className="ml-1 text-slate-400">({offers.length})</span>
      </span>
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
        {offers.map((o) => {
          const current = o.id === currentId;
          return (
            <button key={o.id} type="button" onClick={() => onOpen(o)}
              aria-current={current ? "true" : undefined}
              title={`${o.address || "Offer"} — ${(o.createdAt || "").slice(0, 10)} · open the offer window`}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors ${
                current
                  ? "border-blue-500 bg-blue-50 text-blue-900"
                  : "border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              }`}>
              <span className="max-w-[11rem] truncate font-semibold">
                {String(o.address || "Offer").split(",")[0]}
              </span>
              <span className="tabular-nums text-slate-400">{(o.createdAt || "").slice(5, 10)}</span>
              <StatusPill offer={o} small />
              <CurrentPill offer={o} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- contact picker ---------------- */

function ContactPicker({ selected, onSelect, newContact, setNewContact, mode, setMode, notes = [] }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      setSearching(true);
      searchContacts(query.trim())
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold"><StepBadge n={1} /> Seller contact</h2>
        <div className="flex gap-1 text-xs">
          {["existing", "new"].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-full px-2.5 py-1 font-medium ${
                mode === m ? "bg-blue-600 text-white" : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              {m === "existing" ? "Existing" : "New contact"}
            </button>
          ))}
        </div>
      </div>

      {mode === "existing" ? (
        selected ? (
          <>
            <div className="flex items-center justify-between rounded-lg bg-slate-100 px-3 py-2">
              <a href={ghlContactUrl(selected.id)} target="_blank" rel="noreferrer" title="Open contact in GHL"
                className="group -mx-1 rounded px-1 hover:bg-slate-200">
                <div className="inline-flex items-center gap-1 text-sm font-semibold group-hover:underline">
                  {selected.name || "(no name)"} <ExternalLink size={12} className="text-slate-400" />
                </div>
                <div className="text-xs text-slate-500">{[selected.phone, selected.email].filter(Boolean).join(" · ")}</div>
              </a>
              <button type="button" onClick={() => onSelect(null)} className="rounded p-1 text-slate-400 hover:bg-slate-200">
                <X size={16} />
              </button>
            </div>
            {notes.length > 0 && (
              // Small screens only — on xl+ the sticky NotesPanel rail takes over.
              <details className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 xl:hidden">
                <summary className="cursor-pointer select-none text-xs font-semibold text-slate-600">
                  Recent notes on this contact ({notes.length})
                </summary>
                <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
                  {notes.map((n, i) => (
                    <div key={i} className="rounded-md bg-white px-2.5 py-2 text-xs text-slate-700">
                      {n.dateAdded && (
                        <div className="mb-0.5 text-[10px] font-medium text-slate-400">
                          {new Date(n.dateAdded).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </div>
                      )}
                      <p className="whitespace-pre-wrap">{n.body}</p>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="relative">
            <div className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2">
              <Search size={15} className="text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search contacts by name, phone, or email…"
                className="w-full text-sm focus:outline-none"
              />
              {searching && <Loader2 size={15} className="animate-spin text-slate-400" />}
            </div>
            {results.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                {results.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { onSelect(c); setQuery(""); setResults([]); }}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="font-medium">{c.name || "(no name)"}</span>
                    <span className="ml-2 text-xs text-slate-500">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className={INPUT_CLS} value={newContact.name}
              onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} placeholder="Dana Whitfield" />
          </Field>
          <Field label="Phone (required)">
            <input className={INPUT_CLS} value={newContact.phone}
              onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} placeholder="+1 253 555 0142" />
          </Field>
        </div>
      )}
    </div>
  );
}

// Numbered section badge — the New Offer page reads top-to-bottom as steps.
export function StepBadge({ n }) {
  return (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold leading-none text-white">
      {n}
    </span>
  );
}

/* ---------------- the cash offer card ---------------- */

function OfferCards({ calc, underwriteMode, setUnderwriteMode, priceOverride, setPriceOverride, feeOverride, setFeeOverride, uwOverrides, setUw, settings, fmtTyped }) {
  const modeToggle = (
    <div className="inline-flex flex-wrap rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold">
      {UNDERWRITE_MODES.map((m) => (
        <button key={m.key} type="button" onClick={() => setUnderwriteMode(m.key)} title={m.hint}
          className={`rounded-md px-3 py-1.5 ${underwriteMode === m.key ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
          {m.label}
        </button>
      ))}
    </div>
  );
  if (!calc) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
        <div className="mb-3">{modeToggle}</div>
        Enter an ARV (or use the comps below) to see the cash offer.
      </div>
    );
  }
  const { cash } = calc.offers;
  // Every leg of the carry, spelled out on hover — the number moved a long way
  // when it stopped being a flat guess, so it has to be inspectable.
  const hd = cash.holdingDetail;
  const holdTip = hd?.model === "scaled"
    ? [
        `Loan ${fmtMoney(hd.loanAmount)} (${settings?.loanToCostPct ?? DEFAULT_OFFER_SETTINGS.loanToCostPct}% of purchase + rehab)`,
        `Points ${fmtMoney(hd.points)}, once`,
        `Interest ${fmtMoney(hd.interest)}/mo`,
        `Taxes ${fmtMoney(hd.taxes)}/mo`,
        `Insurance ${fmtMoney(hd.insurance)}/mo`,
        `Utilities & upkeep ${fmtMoney(hd.utilities)}/mo`,
      ].join("\n")
    : "Flat monthly carry — change the model in Settings to size it off the deal.";
  const Row = ({ label, value }) => (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
  // The editable fee row is shared by every mode — it's the one deduction the
  // user reaches for on almost every deal. The blend takes it without the "−":
  // each averaged model already subtracted it, so the mean is net of it and a
  // minus sign there would read as a second bite.
  const feeRowWith = (label, minus = true) => (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className="flex items-center gap-1 font-medium tabular-nums">
        {minus ? "− $" : "$"}
        <input
          className="w-20 rounded-lg border border-amber-300 bg-white px-1.5 py-0.5 text-right text-sm focus:border-blue-500 focus:outline-none"
          inputMode="numeric"
          placeholder={fmtTyped(String(cash.wholesaleFee))}
          value={feeOverride}
          onChange={(e) => setFeeOverride(fmtTyped(e.target.value))}
        />
      </span>
    </div>
  );
  const feeRow = feeRowWith(cash.mode === "backstack" ? "Assignment fee" : "Fee / spread");
  // A percent/number input that shows the saved setting as its placeholder, so
  // an empty field visibly means "use the default" rather than "zero".
  // Deliberately a function returning JSX, NOT a component: a component
  // declared inside a render is a new type every keystroke, so React would
  // remount the input and the field would lose focus after each character.
  const uwInput = (k, width = "w-12") => (
    <input
      key={k}
      className={`${width} rounded border border-amber-300 bg-white px-1 py-0.5 text-right text-xs tabular-nums focus:border-blue-500 focus:outline-none`}
      inputMode="decimal"
      title={`Per-offer override — blank uses the saved default (${settings?.[k] ?? DEFAULT_OFFER_SETTINGS[k] ?? ""})`}
      placeholder={String(settings?.[k] ?? DEFAULT_OFFER_SETTINGS[k] ?? "")}
      value={uwOverrides?.[k] ?? ""}
      onChange={setUw(k)}
    />
  );
  return (
    <div className="rounded-xl border border-amber-400 bg-amber-50 p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-600"><StepBadge n={5} /> All-cash offer</div>
        {modeToggle}
      </div>
      {cash.underwater && (
        <div className="mb-3 mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          The stack is underwater — repairs, profit and costs exceed the ARV. There's no offer to make here at this
          repair number.
        </div>
      )}
      <div className="sm:flex sm:items-center sm:justify-between sm:gap-8">
        <div>
          <div className="mt-1 text-4xl font-black tracking-tight">{fmtMoney(cash.amount)}</div>
          {cash.overridden ? (
            <div className="mt-1 text-xs text-slate-600">
              manually set — system: {fmtMoney(cash.systemAmount)}{" "}
              <button type="button" onClick={() => setPriceOverride("")} className="font-semibold underline hover:text-slate-800">
                use calculated
              </button>
            </div>
          ) : (
            <div className="mt-1 text-xs text-slate-600">
              {cash.pctOfAsking != null ? `≈ ${cash.pctOfAsking}% of asking · ` : ""}as-is
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
            Offer amount on letter $
            <input
              className="w-32 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-right text-sm font-semibold tabular-nums focus:border-blue-500 focus:outline-none"
              inputMode="numeric" placeholder="auto"
              value={priceOverride}
              onChange={(e) => setPriceOverride(fmtTyped(e.target.value))}
            />
          </label>
        </div>
        <div className="mt-4 w-full max-w-sm space-y-1 border-t border-amber-200 pt-3 sm:mt-0 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          {cash.breakdown ? (
            <>
              {/* The back-stack: every cost between the ARV and the offer, in
                  the order they come out. The percentages and the carry are
                  editable inline because they move deal to deal. */}
              <Row label="ARV" value={fmtMoney(cash.base)} />
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="flex items-center gap-1 text-slate-600">Selling costs {uwInput("sellingCostPct")}%</span>
                <span className="font-medium tabular-nums">− {fmtMoney(cash.sellingCosts)}</span>
              </div>
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="flex items-center gap-1 text-slate-600">Flip profit {uwInput("flipProfitPct")}%</span>
                <span className="font-medium tabular-nums">− {fmtMoney(cash.flipProfit)}</span>
              </div>
              <Row label="Repairs" value={`− ${fmtMoney(cash.repairs)}`} />
              {/* Under the scaled model the $/mo is an OUTPUT — loan carry,
                  taxes, insurance and utilities sized off this deal — so it's
                  shown, not typed. Months stays editable: it's the one carry
                  input that genuinely moves property to property. */}
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="flex items-center gap-1 text-slate-600">
                  Holding {uwInput("holdMonths", "w-9")}mo ×{" "}
                  {hd?.model === "scaled"
                    ? <span className="tabular-nums" title={holdTip}>{fmtMoney(hd.monthly)}/mo</span>
                    : <>${uwInput("holdMonthlyCost", "w-14")}</>}
                </span>
                <span className="font-medium tabular-nums" title={holdTip}>− {fmtMoney(cash.holding)}</span>
              </div>
              {feeRow}
              <div className="!mt-2 border-t border-amber-200 pt-2 text-[11px] text-slate-600">
                lands at ≈{cash.pctOfArv}% of ARV before repairs, holding and fee
                {hd?.model === "scaled" && hd.loanAmount > 0 && (
                  <> · carry on a {fmtMoney(hd.loanAmount)} loan</>
                )}
              </div>
            </>
          ) : cash.components ? (
            <>
              {/* The blend shows its work as the three numbers it averaged —
                  they disagree on purpose, and seeing the spread is the point.
                  No arithmetic column: nothing is being subtracted here. */}
              {cash.components.map((p) => (
                <Row key={p.key} label={p.label} value={fmtMoney(p.amount)} />
              ))}
              <div className="!mt-2 flex justify-between gap-4 border-t border-amber-200 pt-2 text-sm font-semibold">
                <span className="text-slate-700">Average</span>
                <span className="tabular-nums">{fmtMoney(cash.amount)}</span>
              </div>
              {feeRowWith("Fee / spread (inside each)", false)}
              <div className="!mt-2 border-t border-amber-200 pt-2 text-[11px] text-slate-600">
                the mean of all three models — ≈{cash.pctOfArv}% of ARV, already net of your fee
              </div>
            </>
          ) : (
            <>
              <Row label={`~${cash.pctOfArv}% of ARV`} value={fmtMoney(cash.base)} />
              <Row label={cash.mode === "mao" ? "Repairs" : "Repair adjustment"} value={`− ${fmtMoney(cash.repairAdjustment)}`} />
              {feeRow}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- main view ---------------- */

// Default "Tentative terms" rows for the letter. When the user has saved a
// template (Settings.letterTermsTemplate — "Save as default template"), every
// new offer seeds from it; otherwise the classic five rows below. Every row
// is fully editable per offer, and Purchase Price always prints first.
const defaultTermRows = (s) => {
  if (Array.isArray(s?.letterTermsTemplate) && s.letterTermsTemplate.length) {
    return s.letterTermsTemplate.map((r, i) => ({
      id: `tpl-${i}`, label: String(r?.label || ""), value: String(r?.value || ""),
    }));
  }
  return builtinTermRows(s);
};
const builtinTermRows = (s) => [
  { id: "financing", label: "Financing", value: String(s?.termFinancing || "").trim() || "Funded with cash or private loan" },
  { id: "earnest", label: "Earnest Money", value: `${fmtMoney(s?.earnestMoney ?? 2500)}, deposited with escrow upon mutual acceptance` },
  { id: "closing", label: "Closing Date", value: String(s?.termClosing || "").trim() || "On or before 14 days from acceptance — or a date of your choosing" },
  { id: "condition", label: "Condition", value: String(s?.termCondition || "").trim() || "Purchased strictly as-is; no repairs or clean-out required" },
  { id: "possession", label: "Possession", value: String(s?.termPossession || "").trim() || "At closing, or flexible if you need additional time" },
];

// Pre-revamp snapshots stored terms as a fixed object of overrides — fold
// them into the classic rows (they predate templates).
const legacyTermsToRows = (t, s) =>
  builtinTermRows({
    ...(s || {}),
    ...(String(t?.financing || "").trim() ? { termFinancing: t.financing } : {}),
    ...(String(t?.closing || "").trim() ? { termClosing: t.closing } : {}),
    ...(String(t?.condition || "").trim() ? { termCondition: t.condition } : {}),
    ...(String(t?.possession || "").trim() ? { termPossession: t.possession } : {}),
    ...(String(t?.earnestMoney || "").trim() ? { earnestMoney: Number(String(t.earnestMoney).replace(/[^\d]/g, "")) || undefined } : {}),
  });

// A room worth mentioning on this form: one pinning ARV or rehab. A pinned
// purchase price is the assignment number and belongs to the deal page alone —
// this form never sets it, so it isn't this form's business to unpin.
const hasFigurePin = (r) => Number(r?.pins?.arv) > 0 || Number(r?.pins?.repairs) > 0;

const moneyNum = (v) => Number(String(v ?? "").replace(/[^\d]/g, "")) || 0;

// Why the number typed here isn't the number investors are looking at. There
// are exactly two answers, and both used to be invisible from this screen:
//
//   1. It was never saved. Autosave writes the workspace — comps, scope, the
//      typed figures — so a reload brings the new ARV back and it reads as
//      committed. But the offer of record, its documents and every deal page
//      built from it still hold the old one until Save changes. That gap is
//      the whole bug this notice exists to close.
//   2. The deal page pinned its own figure (DataroomModal's "Headline
//      numbers"), which deliberately outranks the offer.
//
// Said beside the field being typed in, with the one button that fixes it.
// Where the save as you type stands (offer-autosave.js). Quiet on purpose:
// it's there to be glanced at, not read.
export function SaveStatus({ state, row }) {
  const at = state?.at ? new Date(state.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
  const text = state?.phase === "pending" || state?.phase === "saving" ? "Saving…"
    : state?.phase === "error" ? `Couldn't save${state.error?.message ? ` (${state.error.message})` : ""} — trying again`
    : state?.phase === "saved" ? `Saved ${at}`
    : row ? "Saved" : "Saves as you type";
  const tone = state?.phase === "error" ? "text-red-700" : "text-slate-400";
  return <p role="status" aria-live="polite" className={`mt-0.5 text-xs ${tone}`}>{text}</p>;
}

function FigureNotice({ field, typed, saved, rooms, unpinning, onFollow }) {
  const pinned = rooms.filter((r) => Number(r.pins?.[field]) > 0);
  const unsaved = saved > 0 && typed !== saved;
  if (!unsaved && !pinned.length) return null;
  const BTN = "font-semibold text-blue-700 underline hover:text-blue-900 disabled:opacity-50";
  return (
    <p className="mt-1 text-xs text-amber-700">
      {unsaved && (
        <>
          Saving — the offer, its documents and the deal page say {fmtMoney(saved)} until it lands.{" "}
        </>
      )}
      {pinned.length > 0 && (
        <>
          Deal page shows {[...new Set(pinned.map((r) => fmtMoney(Number(r.pins[field]))))].join(" / ")}
          {pinned.length > 1 ? ` (${pinned.length} rooms)` : ""} — set there, so this number won't reach investors.{" "}
          <button type="button" disabled={unpinning} onClick={onFollow} className={BTN}>
            {unpinning ? "Clearing…" : "Follow this offer"}
          </button>
        </>
      )}
    </p>
  );
}

/**
 * <NewOffer settings restore? initialContactId? initialAddress? onOfferSaved onOpenOffer onDeal />
 *   restore          the draft or offer to edit; absent starts a new one
 *   initialAddress   a full address to start a new one on (a pane row's house)
 *
 * The form moves itself onto another row — the one a house already has, or
 * the same row as another window last saved it — by remounting on that row
 * here. The host hears about it through onOfferSaved.
 */
export default function NewOffer(props) {
  const [swap, setSwap] = useState(null);   // { row, note, n }
  const onSwap = (row, note = "") => {
    setSwap((s) => ({ row, note, n: (s?.n || 0) + 1 }));
    props.onOfferSaved?.(row);
  };
  return (
    <OfferEditor key={swap ? `${swap.row.id}:${swap.n}` : "own"} {...props}
      restore={swap ? swap.row : props.restore}
      initialContactId={swap ? undefined : props.initialContactId}
      initialAddress={swap ? undefined : props.initialAddress}
      openedNote={swap?.note || ""} onSwap={onSwap} />
  );
}

function OfferEditor({ settings, initialContactId, initialAddress = "", restore, onSettingsSaved, onOpenOffer, onOfferSaved, onDeal, openedNote = "", onSwap }) {
  // `restore` reopens a saved draft or an existing offer. Both carry a full
  // form snapshot (drafts in .draft, created offers in .snapshot) so the
  // comps workspace and rehab scope come back exactly as they were; very old
  // offers without a snapshot fall back to deriving inputs from the calc.
  const snap = restore?.status === "draft" ? restore.draft : restore?.snapshot || null;
  // The row this form is on. It starts as `restore` and moves with every save:
  // the first one makes the row, Send turns the draft into the offer on it.
  const [row, setRow] = useState(restore || null);
  const rowRef = useRef(row);
  rowRef.current = row;
  useEffect(() => { if (restore?.id && restore.id === rowRef.current?.id) setRow(restore); }, [restore]);
  const fromOffer = row && row.status !== "draft" ? row : null;
  const fmtN = (n) => (Number(n) ? Number(n).toLocaleString("en-US") : "");

  const [mode, setMode] = useState(snap?.mode || "existing");
  // The snapshot's contact when there is one, else the one stored on the row
  // itself. Drafts used to read only the snapshot, so an auto-underwrite draft
  // — which knows exactly whose agent it is, on the record — reopened with an
  // empty Seller contact and a disabled Create button, for a contact the
  // record could name all along.
  const [contact, setContact] = useState(
    snap?.contact ||
    (restore?.contactId
      ? { id: restore.contactId, name: restore.contactName || "", phone: "", email: "" }
      : null)
  );
  const [newContact, setNewContact] = useState(snap?.newContact || { name: "", phone: "" });
  const BLANK_INPUTS = { address: "", askingPrice: "", arv: "", repairs: "", priceOverride: "" };
  const [inputs, setInputs] = useState(
    snap?.inputs ? { ...BLANK_INPUTS, ...snap.inputs } :
    !restore && /,/.test(initialAddress) ? { ...BLANK_INPUTS, address: initialAddress } :
    (fromOffer?.calc
      ? {
          ...BLANK_INPUTS,
          address: fromOffer.calc.inputs.address || "",
          askingPrice: fmtN(fromOffer.calc.inputs.askingPrice),
          arv: fmtN(fromOffer.calc.inputs.arv),
          repairs: fmtN(fromOffer.calc.inputs.repairs),
          priceOverride: fmtN(fromOffer.calc.inputs.priceOverride),
        }
      : BLANK_INPUTS)
  );
  // Per-offer fee/spread override ("" → use the settings default).
  const [feeOverride, setFeeOverride] = useState(snap?.feeOverride ?? "");
  // Per-offer letter terms: a fully flexible row list (label + printed text).
  const [letterTerms, setLetterTerms] = useState(() =>
    Array.isArray(snap?.letterTerms)
      ? snap.letterTerms.map((r, i) => ({ id: r.id || `t-${i}`, label: String(r.label || ""), value: String(r.value || "") }))
      : snap?.terms
      ? legacyTermsToRows(snap.terms, settings)
      : defaultTermRows(settings)
  );
  // Settings load async on a fresh form — reseed the default rows once they
  // arrive, unless the rows came from a snapshot or were already edited.
  const termsTouchedRef = useRef(Boolean(snap?.letterTerms || snap?.terms));
  // Not an edit: the save-as-you-type signature takes the reseeded rows as
  // its starting point (rebaseline), so opening an older offer never
  // re-renders its letter.
  const rebaseline = useRef(false);
  useEffect(() => {
    if (termsTouchedRef.current || !settings) return;
    rebaseline.current = true;
    setLetterTerms(defaultTermRows(settings));
  }, [settings]);
  const touchTerms = () => { termsTouchedRef.current = true; };
  const patchTerm = (id, p) => { touchTerms(); setLetterTerms((rows) => rows.map((r) => (r.id === id ? { ...r, ...p } : r))); };
  const removeTerm = (id) => { touchTerms(); setLetterTerms((rows) => rows.filter((r) => r.id !== id)); };
  const addTerm = () => { touchTerms(); setLetterTerms((rows) => [...rows, { id: `t-${Date.now()}`, label: "", value: "" }]); };
  const moveTerm = (id, dir) => {
    touchTerms();
    setLetterTerms((rows) => {
      const i = rows.findIndex((r) => r.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= rows.length) return rows;
      const next = [...rows];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  // "Offer expires" date (yyyy-mm-dd) — prints as the letter's "valid
  // through" date ("" → today + validityDays, which the picker shows).
  const [offerExpires, setOfferExpires] = useState(String(snap?.offerExpires ?? ""));
  // Save the current rows as the location-wide template every new offer
  // seeds from; reset reverts this offer's rows to that template.
  const [tplSaving, setTplSaving] = useState(false);
  const [tplSaved, setTplSaved] = useState(false);
  async function saveTermsTemplate() {
    if (!settings) return; // settings still loading — a save now would clobber them
    setTplSaving(true);
    setError("");
    try {
      const template = letterTerms
        .map((r) => ({ label: r.label.trim(), value: r.value.trim() }))
        .filter((r) => r.label && r.value);
      const r = await saveSettings({ ...settings, letterTermsTemplate: template });
      onSettingsSaved?.(r.settings);
      setTplSaved(true);
      setTimeout(() => setTplSaved(false), 2500);
    } catch (e) { setError(e.message); }
    setTplSaving(false);
  }
  const resetTermsToTemplate = () => {
    termsTouchedRef.current = true; // an explicit reset shouldn't be re-seeded over
    setLetterTerms(defaultTermRows(settings));
  };
  const [contactNotes, setContactNotes] = useState([]); // recent GHL notes on the selected contact
  const [underwriteMode, setUnderwriteMode] = useState(
    snap?.underwriteMode ||
    fromOffer?.calc?.settings?.underwriteMode ||
    settings?.underwriteMode ||
    DEFAULT_OFFER_SETTINGS.underwriteMode
  );
  // Per-offer back-stack overrides ("" → fall through to the saved setting).
  // Profit expectations and carry vary deal to deal — a rural flip carried
  // through winter isn't the same underwrite as a 60-day suburban cosmetic.
  const BLANK_UW = { sellingCostPct: "", flipProfitPct: "", holdMonths: "", holdMonthlyCost: "" };
  const [uwOverrides, setUwOverrides] = useState({ ...BLANK_UW, ...(snap?.uwOverrides || {}) });
  const setUw = (k) => (e) =>
    setUwOverrides((s) => ({ ...s, [k]: e.target.value.replace(/[^\d.]/g, "") }));
  const [subjectSqft, setSubjectSqft] = useState(snap?.subjectSqft || ""); // shared: comps $/sqft + rehab per-sqft items
  const [subjectInfo, setSubjectInfo] = useState(snap?.subjectInfo || null); // beds/baths from the comps subject record
  // The kind of house you picked (shared/asset-type.js), or null to go by
  // what Zillow said on the subject record. Kept in the workspace so a draft
  // reopens on it; a pick already saved on the offer is the starting point.
  const [assetPick, setAssetPick] = useState(() => snap?.assetPick
    || (fromOffer?.asset?.by === "you" ? { type: fromOffer.asset.type, land: fromOffer.asset.land || "" } : null));
  const zillowAsset = assetFromHomeType(subjectInfo?.homeType);
  const assetType = assetPick?.type || zillowAsset || "";
  // Which way it's priced (shared/underwrite-model.js): comps for a house,
  // income for multi-family and commercial, land by the acre. A saved offer
  // reopens on the way it was priced — an older multi-family priced by comps
  // stays on comps until you switch it.
  const [uwModel, setUwModel] = useState(() => {
    const m = snap?.model || fromOffer?.calc?.model;
    return m === "income" || m === "land" ? m : "comps";
  });
  // One deal per kind, so trying Commercial and coming back keeps the rent roll.
  const [uwDeals, setUwDeals] = useState(() => {
    const d = snap?.underwrite?.deal || fromOffer?.calc?.underwrite?.deal || null;
    return d?.kind ? { [d.kind]: d } : {};
  });
  const pickAssetType = (type) => {
    setAssetPick(type ? { type, land: type === "manufactured" ? (assetPick?.land || "") : "" } : null);
    setUwModel(modelForAsset(type));
  };
  const pickLand = (land) => setAssetPick({ type: "manufactured", land });
  const incomeKind = assetType === "commercial" ? "commercial" : "multi_family";
  const dealKey = uwModel === "land" ? "land" : incomeKind;
  const uwDeal = uwModel === "comps" ? null
    : uwDeals[dealKey] || (uwModel === "land" ? blankLandDeal() : blankIncomeDeal(incomeKind));
  const setUwDeal = (d) => setUwDeals((m) => ({ ...m, [dealKey]: d }));
  const uwBody = uwModel === "comps" ? undefined : { model: uwModel, deal: uwDeal };
  // Comps for a mobile home are mobile homes (the pull keeps to houses otherwise).
  const compsHomeType = assetType === "manufactured" ? "MANUFACTURED" : assetType === "multi_family" ? "MULTI_FAMILY" : undefined;
  const [scope, setScope] = useState(snap?.scope || fromOffer?.scope || []); // applied rehab line items
  const [saveWarnings, setSaveWarnings] = useState([]);
  const rehabStateRef = useRef(snap?.rehab || null);
  const compsStateRef = useRef(snap?.comps || null);
  // The buyer-view checks (shared/underwrite-checks.js) when switched on in
  // Settings: the Comps pane takes the ARV half, the Rehab pane the scope
  // half; the add-a-bath cure and the listing's remarks cross between them.
  const uwChecks = useMemo(() => checksFor(settings), [settings]);
  const [paneCures, setPaneCures] = useState([]);
  const [scanRemarks, setScanRemarks] = useState(snap?.rehab?.listing?.remarks || "");
  // What the comps and rehab panes open on. State, not a constant, because
  // an auto-underwrite from this form replaces both workspaces in place:
  // the nonce remounts the two panes on the new state and nothing else.
  const [paneInit, setPaneInit] = useState(() => ({
    nonce: 0,
    rehab: snap?.rehab ||
      (fromOffer?.scope?.length
        ? { custom: fromOffer.scope.map((s, i) => ({ id: `c-${i}`, label: s.label, cost: s.cost })) }
        : undefined),
    comps: snap?.comps || undefined,
  }));
  const rehabInit = paneInit.rehab;
  const compsInit = paneInit.comps;

  // Take an auto-underwrite's workspace into THIS form. Everything the run
  // decided lands where a person would have put it: the numbers in the
  // Property step, the subject facts, the priced scope, and both panes
  // reopened on the run's comps and room-by-room rehab state. The address
  // is left as typed — the run resolved it, and the resolved form is what
  // the comps were pulled on, so that one is adopted.
  const applyUnderwrite = React.useCallback((uw) => {
    if (!uw) return;
    const inp = uw.inputs || {};
    setInputs((s) => ({
      ...s,
      address: inp.address || s.address,
      arv: fmtN(inp.arv) || s.arv,
      repairs: fmtN(inp.repairs) || s.repairs,
      askingPrice: s.askingPrice || fmtN(inp.askingPrice),
    }));
    if (uw.subjectSqft) setSubjectSqft(String(uw.subjectSqft));
    if (uw.subjectInfo) setSubjectInfo(uw.subjectInfo);
    if (Array.isArray(uw.scope)) setScope(uw.scope);
    if (uw.underwriteMode) setUnderwriteMode(uw.underwriteMode);
    rehabStateRef.current = uw.rehab || null;
    compsStateRef.current = uw.comps || null;
    setPaneInit((p) => ({ nonce: p.nonce + 1, rehab: uw.rehab || undefined, comps: uw.comps || undefined }));
  }, []);
  const [preview, setPreview] = useState(null);   // data-url image
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const [sendOpen, setSendOpen] = useState(false); // SendModal (text and/or email via GHL)
  const [contractOpen, setContractOpen] = useState(false); // ContractModal (generic contract PDF)
  const [psaOpen, setPsaOpen] = useState(false); // PsaModal (the signable WA purchase & sale agreement)
  const [assignmentOpen, setAssignmentOpen] = useState(false); // AssignmentModal (dispositions PDF)
  const [netSheetOpen, setNetSheetOpen] = useState(false); // NetSheetModal (seller net comparison)
  const [offerPageOpen, setOfferPageOpen] = useState(false); // OfferPageModal (agent-facing page)
  const [enrichOpen, setEnrichOpen] = useState(false); // EnrichModal (AI conversation → CRM fields)
  const [lastSend, setLastSend] = useState(null);  // most recent send record, for the ✓ banner

  // Everything this agent has been offered, and the popout over it. The
  // editor is where you underwrite ONE property, but the question "what else
  // is open with this agent" arrives mid-underwrite — so their offers sit in a
  // strip above the form and open the same detail window the Offers tab uses.
  // Drafts included: the house a new offer names may already have one.
  const [agentRows, setAgentOffers] = useState([]);
  const agentOffers = useMemo(() => agentRows.filter((o) => o.status !== "draft"), [agentRows]);
  const [peek, setPeek] = useState(null);        // offer whose popout is open
  const [peekSub, setPeekSub] = useState(null);  // { kind, offer } layered over it
  const [statusBusy, setStatusBusy] = useState(false); // an outcome is in flight

  useEffect(() => {
    const id = contact?.id;
    if (!id) { setAgentOffers([]); return; }
    let live = true;
    // The strip shows what went out (agentOffers); drafts stay in agentRows.
    listOffers({ contactId: id, limit: 50 })
      .then((list) => { if (live) setAgentOffers(list || []); })
      .catch(() => { /* the strip is a convenience — never block the form */ });
    return () => { live = false; };
  }, [contact?.id]);

  // The figures as the OFFER OF RECORD holds them — not what's typed above.
  // They differ the moment a figure is edited and stay different until Save
  // changes, which is precisely the window in which the deal page looks broken.
  // Kept in state rather than read off `liveOffer` because the agent strip's
  // rows are trimmed for the table and drop `calc` entirely.
  const [savedInputs, setSavedInputs] = useState(fromOffer?.calc?.inputs || {});
  useEffect(() => { setSavedInputs(fromOffer?.calc?.inputs || {}); }, [fromOffer?.id]);

  // Deal pages built from this offer that are showing a pinned ARV or rehab
  // instead of the offer's own. Read here so the two fields below can admit it
  // — otherwise the operator retypes an ARV, saves, and the deal page never
  // moves, with nothing on this screen explaining why.
  const [pinnedRooms, setPinnedRooms] = useState([]);
  const [unpinning, setUnpinning] = useState("");

  useEffect(() => {
    const id = fromOffer?.id;
    if (!id) { setPinnedRooms([]); return; }
    let live = true;
    listDatarooms(id)
      .then((rooms) => { if (live) setPinnedRooms((rooms || []).filter(hasFigurePin)); })
      .catch(() => { /* a note beside a field — never block the form */ });
    return () => { live = false; };
  }, [fromOffer?.id]);

  // Unpin one figure on every room holding it. The room's own PUT re-derives
  // the number from the offer as it stands today, so the deal page lands on
  // whatever this form last saved — no second save needed here.
  async function followOffer(field) {
    const rooms = pinnedRooms.filter((r) => Number(r.pins?.[field]) > 0);
    if (!rooms.length || unpinning) return;
    setUnpinning(field);
    setError("");
    try {
      await Promise.all(rooms.map((r) => updateDataroom(r.id, { numbers: { [field]: null } })));
      setPinnedRooms((list) => list
        .map((r) => ({ ...r, pins: { ...r.pins, [field]: 0 } }))
        .filter(hasFigurePin));
    } catch (e) { setError(e.message); }
    setUnpinning("");
  }

  // "Mark under contract" from the popout, when the shell can take us to the
  // Deals tab. Without that navigation the button would strand you, so the
  // modal simply doesn't render it (the handler is what turns it on).
  async function promoteFromPeek(o) {
    try {
      const r = await promoteDeal(o.id);
      patchPeek(r.offer);
      setPeek(null);
      onDeal?.();
    } catch (e) {
      if (e.status === 409) { setPeek(null); onDeal?.(); } // already a deal — just go there
      else setError(e.message);
    }
  }

  // Record an outcome — sent, countered, passed — without leaving the form.
  //
  // Same single endpoint the Offers table uses, deliberately: the ledger entry,
  // the agent_deal_history line in GHL and the contact's status tag are written
  // in exactly one place, so a status set from here is indistinguishable from
  // one set from the table. "accepted" promotes to a deal server-side and comes
  // back flagged, which is why this can land you on the Deals tab.
  async function changeOfferStatus(o, status) {
    if (!o?.id || statusBusy) return;
    setStatusBusy(true);
    setError("");
    try {
      const r = await setOfferStatus(o.id, status);
      // A pin moves: the server cleared it on this row's siblings.
      if (status === MAKE_CURRENT && r.offer) {
        const k = houseKey(r.offer.address || "");
        setAgentOffers((list) => list.map((x) => (x.id !== r.offer.id && x.pin && houseKey(x.address || "") === k ? { ...x, pin: undefined } : x)));
      }
      patchPeek(r.offer);
      if (r.offer?.id && r.offer.id === rowRef.current?.id) adopt(r.offer);
      onOfferSaved?.(r.offer); // the shell holds the offer being edited
      if (r.promoted) { setPeek(null); onDeal?.(); }
    } catch (e) { setError(e.message); }
    setStatusBusy(false);
  }

  // One patcher for every copy of an offer the popout is holding.
  const patchPeek = (updated) => {
    if (!updated) return;
    setPeek((p) => (p && p.id === updated.id ? updated : p));
    setPeekSub((s) => (s && s.offer.id === updated.id ? { ...s, offer: updated } : s));
    setAgentOffers((list) => list.map((o) => (o.id === updated.id ? updated : o)));
  };

  // The agent's rows, each told whether it's its house's current offer
  // (shared/current-offer.js). Derived, so a status or pin patched into
  // agentOffers re-reads.
  const agentBook = annotateCurrent(agentOffers);
  const verdictOf = (o) => {
    const v = o?.id ? agentBook.find((x) => x.id === o.id) : null;
    return v ? { ...o, isCurrent: v.isCurrent, supersededBy: v.supersededBy, currentPinned: v.currentPinned, houseOffers: v.houseOffers } : o;
  };
  // The offer being edited, as freshly as we know it. `restore` is a prop and
  // can lag a status recorded here by a render; the agent strip is refetched
  // and patched, so prefer its copy.
  const liveOffer = fromOffer
    ? verdictOf(agentOffers.find((o) => o.id === fromOffer.id) || fromOffer)
    : null;
  // The status control also shows on a draft: a held underwrite you answered
  // yourself, or a house you're walking from, is closed out right here.
  const statusOffer = liveOffer || (row?.id ? verdictOf(agentOffers.find((o) => o.id === row.id) || row) : null);
  const currentOfHouse = liveOffer?.supersededBy ? agentBook.find((o) => o.id === liveOffer.supersededBy.id) : null;

  // "Re-quote at 400K" from the held-paper banner: re-priced in place, sent
  // by nobody — Send is the next press.
  const [requoting, setRequoting] = useState(false);
  async function requote(o, amount) {
    if (!o?.id || requoting) return;
    setRequoting(true);
    setError("");
    try {
      const r = await requoteOffer(o.id, amount);
      patchPeek(r.offer);
      if (r.offer?.id && r.offer.id === rowRef.current?.id) { adopt(r.offer); setSavedInputs(r.offer.calc?.inputs || {}); }
      onOfferSaved?.(r.offer);
    } catch (e) { setError(e.message); }
    setRequoting(false);
  }

  // Money fields format with thousands separators as you type; the calc
  // engine strips $ , and spaces, so the formatted string feeds it directly.
  const fmtTyped = (v) => { const d = String(v).replace(/[^\d]/g, ""); return d ? Number(d).toLocaleString("en-US") : ""; };
  const setMoney = (k) => (e) => setInputs((s) => ({ ...s, [k]: fmtTyped(e.target.value) }));

  // Deep link (?contact_id= from the GHL contact panel): preselect the
  // contact and prefill their property address.
  useEffect(() => {
    if (!initialContactId || contact) return;
    getContactDetail(initialContactId)
      .then((d) => {
        setContact({ id: d.id, name: d.name, phone: d.phone, email: d.email });
        // The whole address (street, city, state, ZIP) when the record can
        // finish the shorthand field; the field itself otherwise.
        const addr = d.address || pickContactAddress(d.custom);
        if (addr) setInputs((s) => (s.address.trim() ? s : { ...s, address: addr }));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContactId]);

  // The contact's GHL notes (all of them) — covers manual selection, the
  // ?contact_id= deep link, and draft/offer restore alike. Errors surface in
  // the panel instead of being swallowed.
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState("");
  useEffect(() => {
    setContactNotes([]);
    setNotesError("");
    if (mode !== "existing" || !contact?.id) return;
    setNotesLoading(true);
    getContactNotes(contact.id)
      .then((n) => setContactNotes(n || []))
      .catch((e) => setNotesError(e.message))
      .finally(() => setNotesLoading(false));
  }, [contact?.id, mode]);

  async function addNote(body) {
    await addContactNote(contact.id, body);
    const n = await getContactNotes(contact.id).catch(() => null);
    if (n) setContactNotes(n);
    else setContactNotes((list) => [{ body, dateAdded: new Date().toISOString() }, ...list]);
  }

  // Selecting a contact pulls their custom fields and prefills the address
  // (Property Address Short Hand etc.) — without clobbering anything typed.
  function selectContact(c) {
    setContact(c);
    if (!c?.id) return;
    getContactDetail(c.id)
      .then((d) => {
        const addr = d.address || pickContactAddress(d.custom);
        if (addr) setInputs((s) => (s.address.trim() ? s : { ...s, address: addr }));
      })
      .catch(() => {});
  }

  // Local yyyy-mm-dd strings for the "Offer expires" picker (en-CA formats
  // as ISO); the default the picker shows matches the server's fallback of
  // today + validityDays.
  const todayIso = new Date().toLocaleDateString("en-CA");
  const expiryDefault = new Date(Date.now() + (Number(settings?.validityDays) || 7) * 86400000).toLocaleDateString("en-CA");

  // The per-offer underwrite toggle + fee override ride on top of the saved
  // settings for the live preview, the rendered document, and the created
  // offer alike.
  const effSettings = useMemo(() => {
    const s = { ...(settings || {}), underwriteMode };
    if (String(feeOverride).trim() !== "") {
      s.wholesaleFee = Number(String(feeOverride).replace(/[^\d]/g, "")) || 0;
    }
    for (const [k, v] of Object.entries(uwOverrides)) {
      const raw = String(v).trim();
      if (raw === "") continue;            // blank means "use the saved default"
      // Mid-typing garbage ("7." is fine, "7.5.5" isn't) keeps the default
      // rather than silently underwriting at zero.
      const n = Number(raw);
      if (Number.isFinite(n)) s[k] = n;
    }
    if (offerExpires) s.offerExpires = offerExpires;
    // The letter prints exactly these rows (after Purchase Price) — an empty
    // list is honored, so deleted rows stay deleted.
    s.letterTerms = letterTerms
      .map((r) => ({ label: r.label.trim(), value: r.value.trim() }))
      .filter((r) => r.label && r.value);
    return s;
    // uwOverrides belongs here as much as feeOverride does: leaving it out
    // froze the whole stack — you could type a new selling-cost or profit
    // percentage, watch the field change, and the offer never moved.
  }, [settings, underwriteMode, feeOverride, uwOverrides, offerExpires, letterTerms]);

  const calc = useMemo(() => {
    try {
      if (uwModel !== "comps") return buildUnderwriteCalc({ model: uwModel, deal: uwDeal, inputs, settings: effSettings });
      return calculateOffers(inputs, effSettings);
    } catch {
      return null;
    }
  }, [inputs, effSettings, uwModel, uwDeal]);
  // The analyzer's full answer (tests, metrics, flags) for the income and land panes.
  const uwRun = useMemo(
    () => (uwModel === "comps" ? null : runAnalyzer(uwModel, { ...uwDeal, askingPrice: moneyNum(inputs.askingPrice) })),
    [uwModel, uwDeal, inputs.askingPrice],
  );

  // The buyer ceiling beside the offer: what a flipper's rule says they will
  // pay in total, so an offer that leaves no room for our fee reads as one
  // before it is sent. A readout only — the three deals that fell through
  // were all written above this line, and both that sold were written at it.
  const ceiling = useMemo(() => {
    if (!calc || calc.model) return null;
    const c = buyerCeiling({ offer: { arv: calc.inputs.arv, repairs: calc.inputs.repairs }, settings: effSettings, fee: effSettings.wholesaleFee });
    if (!c.computable) return null;
    const ask = Math.round(calc.offers.cash.amount) + Math.round(Number(effSettings.wholesaleFee) || 0);
    return { ...c, ask, over: ask - c.noFee };
  }, [calc, effSettings]);

  const contactName = mode === "existing" ? contact?.name || "" : newContact.name;
  // Send needs a house, a number and someone to send it to.
  const canSend = Boolean(calc && namesAHouse(inputs.address) && (mode === "existing" ? contact?.id : newContact.phone.trim()));

  async function doPreview() {
    setError(""); setPreviewing(true);
    try {
      const r = await previewDocument(inputs, effSettings, contactName, uwBody);
      setPreview(r.image);
    } catch (e) { setError(e.message); }
    setPreviewing(false);
  }

  // The whole form, in one place. Create, save and autosave all send this — a
  // second copy of the field list is how the three quietly drift apart.
  const formSnapshot = () => ({
    mode, contact, newContact, inputs, subjectSqft, subjectInfo, assetPick, scope, underwriteMode, feeOverride, uwOverrides, letterTerms, offerExpires,
    // How it's priced, and the income or land deal when it isn't comps.
    model: uwModel, underwrite: uwBody || null,
    rehab: rehabStateRef.current,
    comps: compsStateRef.current,
    // The buyer-view checks' record: the Comps pane's ARV half and the Rehab
    // pane's scope half, as one — what a retry reads to keep removals removed.
    checks: combineChecks(compsStateRef.current?.checks || null, rehabStateRef.current?.checks || null),
  });
  const draftBody = () => ({ ...formSnapshot(), cashPreview: calc?.offers?.cash?.amount ?? null });

  // What the offer is made from — Send on a draft and every live save send it.
  const offerBody = () => ({
    contactId: mode === "existing" ? contact?.id : undefined,
    newContact: mode === "new" ? newContact : undefined,
    inputs,
    settings: effSettings,
    scope,
    // Full form snapshot so reopening restores comps + rehab intact.
    snapshot: formSnapshot(),
    // The kind of house, when you picked one (otherwise Zillow's word).
    ...(assetPick ? { asset: assetPick } : {}),
    // An income or land offer is priced on the server from this deal.
    ...(uwBody ? { underwrite: uwBody } : {}),
  });

  /* ---------- saving as you type ---------- */
  // Matt, 2026-10-23: the five save buttons were too confusing and one house
  // kept collecting rows. Now every change saves itself (offer-autosave.js):
  //
  //   a blank form   becomes a draft once it names a house and holds a figure,
  //                  comps or a scope — a contact and an address alone are a
  //                  look, not work. A house that already has a row opens it.
  //   a draft        saves onto itself.
  //   an offer       saves live: the letter behind the agent's link and the
  //                  bot's number follow what you type (Matt chose this over
  //                  holding them until Send). Comps and rehab work that
  //                  doesn't change the letter is a workspace write.
  //
  // Nothing saves until you touch the form: settings arriving, a prefilled
  // address and the panes echoing their restored state aren't edits, and
  // opening an offer to look at it must not re-render its letter.
  const [saveState, setSaveState] = useState({ phase: "idle" });
  const [publishing, setPublishing] = useState(false);
  const [handed, setHanded] = useState(false);
  const [otherWindow, setOtherWindow] = useState(false);
  const [houseHasRow, setHouseHasRow] = useState(null);   // the row this house has, while the form holds work of its own
  const touchedRef = useRef(false);
  const mountedRef = useRef(true);
  const leavingRef = useRef(false);   // moving to another row: this form saves nothing more
  const historyBehindRef = useRef(false);
  const publishingRef = useRef(false);
  const skippedRef = useRef(false);
  const draftBodyRef = useRef(draftBody);
  const snapshotRef = useRef(formSnapshot);
  const offerBodyRef = useRef(offerBody);
  draftBodyRef.current = draftBody;
  snapshotRef.current = formSnapshot;
  offerBodyRef.current = offerBody;
  const touch = () => { touchedRef.current = true; };

  // The row moved under us (a save, Send, a status): keep the newest copy.
  function adopt(offer) {
    if (!offer?.id) return;
    const next = { ...(rowRef.current?.id === offer.id ? rowRef.current : {}), ...offer };
    rowRef.current = next;
    if (!mountedRef.current) return;
    setRow(next);
    setAgentOffers((list) => (list.some((o) => o.id === next.id) ? list.map((o) => (o.id === next.id ? { ...o, ...next } : o)) : [next, ...list]));
  }

  // This house already has a row: work there instead.
  function openRow(other, note) {
    leavingRef.current = true;
    saver.current?.cancel();
    onSwap?.(other, note);
  }

  // Comps that can't be re-fetched, or a rehab scope built by hand.
  const hasWorkToLose = (body) => {
    const c = body.comps || {};
    const d = body.underwrite?.deal || {};
    return Boolean(
      (c.captured || []).length || (c.manual || []).length ||
      (c.selected || []).length || (body.scope || []).length ||
      // A rent roll or land comps typed by hand are work too.
      (d.units || []).length || (d.tenants || []).length || (d.comps || []).length
    );
  };
  const worthARow = (body) => namesAHouse(body.inputs?.address) && (hasWorkToLose(body)
    || ["arv", "repairs", "askingPrice", "priceOverride"].some((k) => String(body.inputs?.[k] || "").trim()));

  async function runSave(kind, { final = false } = {}) {
    if (leavingRef.current) return;
    // Send is turning the draft into the offer: a save now would race it. The
    // work is in what Send sends; anything later is saved once it's done.
    if (publishingRef.current) { skippedRef.current = true; return; }
    const cur = rowRef.current;
    if (!hasPaper(cur)) {
      const body = draftBodyRef.current();
      if (!cur && !worthARow(body)) return;
      if (!kind && cur) return;   // leaving a draft with nothing pending
      // `keep`: what you typed saves here; the house's other row is named
      // (houseRow, below), never swapped in over your numbers.
      const r = await saveDraft(cur?.id || null, body, { keep: true });
      if (r?.reused) { if (mountedRef.current) openRow(r.offer, "Opened the offer you already have on this house."); return; }
      adopt(r?.offer);   // `stale`: it became the offer elsewhere — this is that row now
      // Saved here, and the house has another row too: say so, with Open it.
      if (r?.houseRow && mountedRef.current) setHouseHasRow(r.houseRow);
      return;
    }
    if (kind === "live" || (final && historyBehindRef.current)) {
      const r = await updateOffer(cur.id, { ...offerBodyRef.current(), live: true, final });
      historyBehindRef.current = Boolean(r?.historyBehind);
      adopt(r?.offer);
      if (mountedRef.current && r?.offer) {
        setSavedInputs(r.offer.calc?.inputs || {});
        setSaveWarnings(r.warnings || []);
      }
      return;
    }
    if (kind === "workspace") await saveOfferWorkspace(cur.id, snapshotRef.current());
  }
  const runSaveRef = useRef(runSave);
  runSaveRef.current = runSave;
  const saver = useRef(null);
  if (!saver.current) {
    saver.current = createAutosaver({
      run: (kind, opts) => runSaveRef.current(kind, opts),
      onState: (st) => { if (mountedRef.current) setSaveState(st); },
    });
  }
  const scheduleSave = (letterChanged) => saver.current.schedule(saveKindFor({ row: rowRef.current, letterChanged }));

  // Everything the letter prints, as one string: when it moves after you've
  // touched the form, that's an edit.
  const letterSig = JSON.stringify([mode, contact?.id || "", newContact, inputs, effSettings, scope, uwBody || null, assetPick || null]);
  const lastSig = useRef(letterSig);
  useEffect(() => {
    if (letterSig === lastSig.current) return;
    lastSig.current = letterSig;
    if (rebaseline.current) { rebaseline.current = false; return; }
    if (touchedRef.current) scheduleSave(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [letterSig]);

  // Both panes report their state on mount and again as they settle — the
  // restored workspace echoing back, not work anybody did. A report saves
  // when its content moved and you've touched the form, or when comps were
  // captured off Zillow (they exist nowhere else; you captured them in
  // another tab). Without the content check, two windows on one offer
  // reloaded each other forever: each mount's echo saved, which reloaded the
  // other window, whose mount echoed…
  const paneSeen = useRef({});
  const reportPaneState = (which, ref) => (st) => {
    ref.current = st;
    const sig = JSON.stringify(st ?? null);
    const captured = (st?.captured || []).length;
    const seen = paneSeen.current[which];
    paneSeen.current[which] = { sig, captured };
    if (!seen || seen.sig === sig) return;
    if (touchedRef.current || captured > seen.captured) scheduleSave(false);
  };
  // A rent roll or land comps typed by hand save the same way — when they
  // actually moved, and you moved them (a mount, even twice over in
  // StrictMode, is only the restored deal).
  const dealsSig = JSON.stringify([uwModel, uwDeals]);
  const lastDeals = useRef(dealsSig);
  useEffect(() => {
    if (dealsSig === lastDeals.current) return;
    lastDeals.current = dealsSig;
    if (touchedRef.current) scheduleSave(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealsSig]);

  // A new offer on a house this agent already has a row on opens that row —
  // straight away while the form is only a contact and an address, with a
  // button once you've started on numbers of your own.
  useEffect(() => {
    if (rowRef.current || !contact?.id || !namesAHouse(inputs.address)) { setHouseHasRow(null); return undefined; }
    const t = setTimeout(() => {
      if (rowRef.current || leavingRef.current) return;
      const there = rowOnHouse(agentRows.filter((o) => o.contactId === contact.id), { address: inputs.address });
      if (!there) { setHouseHasRow(null); return; }
      if (worthARow(draftBodyRef.current())) setHouseHasRow(there);
      else openRow(there, "Opened the offer you already have on this house.");
    }, DRAFT_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRows, inputs.address, contact?.id]);

  // The same row saved in another window: reopen on it when nothing here is
  // waiting to save; otherwise say so and let you choose.
  useEffect(() => onOfferChanged((msg) => {
    const cur = rowRef.current;
    if (!cur?.id || msg.local || msg.focus || msg.id !== cur.id) return;
    if (msg.updatedAt && cur.updatedAt && msg.updatedAt <= cur.updatedAt) return;
    if (!saver.current.idle()) { setOtherWindow(true); return; }
    getOffer(cur.id)
      .then((fresh) => { if (fresh && mountedRef.current && saver.current.idle()) openRow(fresh, "Updated from your other window."); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  const loadOtherWindow = () => getOffer(row.id).then((fresh) => fresh && openRow(fresh, "Loaded what your other window saved.")).catch((e) => setError(e.message));

  useEffect(() => {
    mountedRef.current = true;
    // Backgrounding the tab is the other moment a pending save would be lost.
    const onHide = () => { if (document.visibilityState === "hidden") saver.current.flush(); };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      mountedRef.current = false;
      // Leaving the form: fire what's pending, and tell a live offer where
      // you stopped so the agent's history line carries the last number.
      if (!leavingRef.current) saver.current.flush({ final: true });
    };
  }, []);

  // Send on a draft makes it the offer first (the same row: paper, the
  // contact's fields, note and tag), then opens the send window. On a held
  // auto-underwrite, "Let the bot take it" does the first half and hands the
  // conversation to the bot instead.
  async function publish({ handToBot = false } = {}) {
    setError("");
    setPublishing(true);
    try {
      await saver.current.flush();
      publishingRef.current = true;
      let cur = rowRef.current;
      if (!cur) {
        const r = await saveDraft(null, draftBodyRef.current());
        if (r?.reused) { openRow(r.offer, "Opened the offer you already have on this house — press Send there."); return; }
        adopt(r.offer);
        cur = r.offer;
      }
      let offer;
      try {
        offer = (await publishOffer(cur.id, offerBodyRef.current(), { handToBot })).offer;
      } catch (e) {
        if (e.status !== 409) throw e;
        offer = await getOffer(cur.id);   // made into an offer already (another window)
      }
      adopt(offer);
      setSavedInputs(offer?.calc?.inputs || {});
      onOfferSaved?.(offer);
      if (handToBot) setHanded(true);
      else setSendOpen(true);
    } catch (e) {
      setError(e.message);
    } finally {
      publishingRef.current = false;
      if (skippedRef.current) { skippedRef.current = false; scheduleSave(true); }
      if (mountedRef.current) setPublishing(false);
    }
  }
  async function sendNow() {
    if (!hasPaper(rowRef.current)) return publish();
    setError("");
    await saver.current.flush();   // the agent gets the number on screen
    setSendOpen(true);
  }

  return (
    // Any change, click or keystroke inside the form is you working on it —
    // the moment saving starts (the letter signature above decides what).
    <div className="flex items-start gap-5" onChangeCapture={touch} onInputCapture={touch} onClickCapture={touch} onKeyDownCapture={touch}>
    <div className="min-w-0 flex-1 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold tracking-tight">
            {row ? (hasPaper(row) ? "Editing offer" : "Editing draft") : "New cash offer"}
          </h1>
          <p className="text-xs text-slate-500">
            {row
              ? `${row.address || inputs.address || "this house"} — saves as you type`
              : "Work top to bottom: contact → property → comps → rehab → offer. It saves as you type."}
          </p>
          <SaveStatus state={saveState} row={row} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Where this offer stands, settable in place. An agent's "we're
              passing" arrives while you're mid-revision on the next number —
              recording it shouldn't cost you a trip to the Offers tab and the
              form you had open. */}
          {statusOffer && (
            <span className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-sm">
              <span className="text-xs font-medium text-slate-500">Status</span>
              <StatusMenu offer={statusOffer} busy={statusBusy} onDealNav={onDeal}
                onSelect={(status) => changeOfferStatus(statusOffer, status)} />
            </span>
          )}
          {/* The editor shows the working copy; this is the offer as it went
              out — the document, what was sent, what came back, and every
              action that follows it. */}
          {fromOffer && (
            <button type="button" onClick={() => setPeek(liveOffer)}
              title="Open the full offer window — document, send history, contract and offer page"
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Maximize2 size={14} /> Offer details
            </button>
          )}
        </div>
      </div>

      {openedNote && (
        <div role="status" className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">{openedNote}</div>
      )}
      {houseHasRow && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="min-w-0 flex-1">You already have {hasPaper(houseHasRow) ? "an offer" : "a draft"} on this house. One house keeps one row.</span>
          <button type="button" onClick={() => openRow(houseHasRow, "Opened the offer you already have on this house.")} className="font-semibold underline">Open it</button>
        </div>
      )}
      {otherWindow && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="min-w-0 flex-1">This offer changed in your other window. What you type here still saves over it.</span>
          <button type="button" onClick={loadOtherWindow} className="font-semibold underline">Load it</button>
        </div>
      )}

      <AgentOfferTabs offers={agentBook} currentId={fromOffer?.id}
        contactName={contact?.name} onOpen={setPeek} />

      {/* You're editing a row the house has moved past. Saving re-prices it
          and makes it current again; say so before that happens by accident. */}
      {liveOffer?.supersededBy && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <span className="min-w-0 flex-1">
            <strong>Superseded.</strong> The current offer on this house is {fmtMoney(liveOffer.supersededBy.cashAmount)} — the bot, the
            nudges and the counters all work from that one. Saving a new number here makes this one current again.
          </span>
          {currentOfHouse && (
            <button type="button" onClick={() => setPeek(currentOfHouse)} className="font-semibold text-blue-700 underline">Open the current one</button>
          )}
          <button type="button" disabled={statusBusy} onClick={() => changeOfferStatus(liveOffer, MAKE_CURRENT)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 font-semibold hover:bg-slate-100 disabled:opacity-60">
            Make this the current offer
          </button>
        </div>
      )}
      {liveOffer && <PaperHeldBanner offer={liveOffer} busy={requoting} onRequote={(amount) => requote(liveOffer, amount)} />}

      <ContactPicker
        selected={contact} onSelect={selectContact}
        newContact={newContact} setNewContact={setNewContact}
        mode={mode} setMode={setMode}
        notes={contactNotes}
      />

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold"><StepBadge n={2} /> Property</h2>
        <div className="mb-4">
          <span className={LABEL_CLS}>Property type</span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex flex-wrap rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold" role="group" aria-label="Property type">
              {TYPE_CHOICES.map((c) => {
                const on = (assetType || "sfr") === c.type;
                return (
                  <button key={c.type} type="button" onClick={() => pickAssetType(c.type)} aria-pressed={on}
                    className={`rounded-md px-3 py-1.5 ${on ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
                    {c.label}
                  </button>
                );
              })}
            </div>
            <span className="text-xs text-slate-500">
              Priced by {MODEL_WORDS[uwModel]}
              {!assetPick && zillowAsset ? ` · Zillow: ${ASSET_TYPE_LABELS[zillowAsset]}` : ""}
              {assetPick && zillowAsset && zillowAsset !== assetPick.type && (
                <> · <button type="button" onClick={() => pickAssetType("")} className="underline hover:text-slate-800">use Zillow's ({ASSET_TYPE_LABELS[zillowAsset]})</button></>
              )}
            </span>
          </div>
          {uwModel === "comps" && (assetType === "multi_family" || assetType === "commercial" || assetType === "land") && (
            <p className="mt-2 text-xs text-slate-600">
              {ASSET_TYPE_LABELS[assetType]} — this one is priced with comps.{" "}
              <button type="button" onClick={() => setUwModel(modelForAsset(assetType))} className="font-semibold text-blue-700 underline hover:text-blue-900">
                Underwrite by {assetType === "land" ? "land value" : "income"}
              </button>
            </p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Property address">
              <AddressInput
                value={inputs.address}
                onChange={(v) => setInputs((s) => ({ ...s, address: v }))}
                placeholder="412 Maple Ave SW, Tacoma, WA 98466"
              />
            </Field>
            {inputs.address.trim() && (
              <a href={zillowUrl(inputs.address)} target="_blank" rel="noreferrer"
                className="mt-1 inline-block text-xs font-medium text-blue-700 underline hover:text-blue-900">
                View on Zillow ↗
              </a>
            )}
            {uwModel === "comps" && <AutoUnderwrite
              contactId={mode === "existing" ? contact?.id || null : null}
              address={inputs.address}
              askingPrice={moneyNum(inputs.askingPrice)}
              onApply={applyUnderwrite}
              declined={() => combineChecks(compsStateRef.current?.checks || null, rehabStateRef.current?.checks || null)?.declined || null}
            />}
          </div>
          {uwModel === "comps" && <div>
            <Field label="After-repair value / ARV ($)">
              <input className={INPUT_CLS} inputMode="numeric" value={inputs.arv} onChange={setMoney("arv")} placeholder="from comps below" />
            </Field>
            <FigureNotice field="arv" typed={moneyNum(inputs.arv)} saved={moneyNum(savedInputs.arv)}
              rooms={pinnedRooms}
              unpinning={unpinning === "arv"} onFollow={() => followOffer("arv")} />
          </div>}
          {uwModel === "comps" && <div>
            <Field label="Estimated repairs ($)">
              <input className={INPUT_CLS} inputMode="numeric" value={inputs.repairs} onChange={setMoney("repairs")} placeholder="from scope below" />
            </Field>
            <FigureNotice field="repairs" typed={moneyNum(inputs.repairs)} saved={moneyNum(savedInputs.repairs)}
              rooms={pinnedRooms}
              unpinning={unpinning === "repairs"} onFollow={() => followOffer("repairs")} />
          </div>}
          <Field label={uwModel === "comps" ? "Asking price ($, optional)" : "Asking price ($)"}>
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.askingPrice} onChange={setMoney("askingPrice")} placeholder={uwModel === "comps" ? "for %-of-asking context" : "what the seller wants"} />
          </Field>
          <div>
            {assetType === "manufactured" && (
              <div>
                <Field label="Land">
                  <select className={INPUT_CLS} value={assetPick?.land || ""} onChange={(e) => pickLand(e.target.value)}>
                    <option value="">Not sure yet</option>
                    {MH_LAND.map((l) => <option key={l} value={l}>{MH_LAND_LABELS[l]}</option>)}
                  </select>
                </Field>
              </div>
            )}
            {assetType === "manufactured" && (
              <p className="mt-1 text-xs text-slate-500">Goes to buyers who said they buy mobile homes, not to every flipper in the area.</p>
            )}
          </div>
        </div>
      </div>

      {uwModel === "income" && (
        <IncomeUnderwriter kind={incomeKind} deal={uwDeal} setDeal={setUwDeal} run={uwRun}
          asking={moneyNum(inputs.askingPrice)}
          priceOverride={inputs.priceOverride || ""} setPriceOverride={(v) => setInputs((s) => ({ ...s, priceOverride: v }))}
          fmtTyped={fmtTyped}
          onUseComps={incomeKind === "multi_family" && (uwRun?.result?.inPlace?.size || 0) <= 4 ? () => setUwModel("comps") : null} />
      )}
      {uwModel === "land" && (
        <LandUnderwriter deal={uwDeal} setDeal={setUwDeal} run={uwRun}
          asking={moneyNum(inputs.askingPrice)}
          priceOverride={inputs.priceOverride || ""} setPriceOverride={(v) => setInputs((s) => ({ ...s, priceOverride: v }))}
          fmtTyped={fmtTyped} />
      )}

      {uwModel === "comps" && <>
      <CompsPane
        key={`comps-${paneInit.nonce}`}
        address={inputs.address}
        homeType={compsHomeType}
        sqft={subjectSqft}
        setSqft={setSubjectSqft}
        onSubjectInfo={setSubjectInfo}
        initialState={compsInit}
        onStateChange={reportPaneState("comps", compsStateRef)}
        onUseArv={(arv) => setInputs((s) => ({ ...s, arv: Number(arv).toLocaleString("en-US") }))}
        checks={uwChecks}
        remarks={scanRemarks}
        onChecks={(c) => setPaneCures((prev) => (JSON.stringify(prev) === JSON.stringify(c?.cures || []) ? prev : (c?.cures || [])))}
      />

      <RehabPane
        key={`rehab-${paneInit.nonce}`}
        sqft={subjectSqft}
        beds={Number(subjectInfo?.beds) || 0}
        baths={Number(subjectInfo?.baths) || 0}
        yearBuilt={Number(subjectInfo?.yearBuilt) || 0}
        address={inputs.address}
        initialState={rehabInit}
        onStateChange={(st) => {
          reportPaneState("rehab", rehabStateRef)(st);
          const r = st?.listing?.remarks || "";
          setScanRemarks((prev) => (prev === r ? prev : r));
        }}
        checks={uwChecks}
        arv={Number(String(inputs.arv || "").replace(/[^\d.]/g, "")) || 0}
        cures={paneCures}
        onApply={(total, lines) => {
          setInputs((s) => ({ ...s, repairs: Number(total).toLocaleString("en-US") }));
          setScope(lines);
        }}
      />

      <OfferCards calc={calc} underwriteMode={underwriteMode} setUnderwriteMode={setUnderwriteMode}
        priceOverride={inputs.priceOverride || ""} setPriceOverride={(v) => setInputs((s) => ({ ...s, priceOverride: v }))}
        feeOverride={feeOverride} setFeeOverride={setFeeOverride}
        uwOverrides={uwOverrides} setUw={setUw} settings={settings} fmtTyped={fmtTyped} />
      </>}

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold">Letter terms</h2>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            Offer expires
            <input
              type="date"
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
              value={offerExpires || expiryDefault}
              min={todayIso}
              onChange={(e) => setOfferExpires(e.target.value)}
            />
          </label>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          The "Tentative terms" printed on the offer letter — edit any label or text, remove, reorder, or add rows.
          "Purchase Price" always prints first. The date above prints as the offer's valid-through date.
        </p>
        <div className="space-y-2">
          {letterTerms.map((row, i) => (
            <div key={row.id} className="flex items-center gap-2">
              <div className="flex shrink-0 flex-col">
                <button type="button" onClick={() => moveTerm(row.id, -1)} disabled={i === 0}
                  className="rounded p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30" title="Move up">
                  <ChevronUp size={13} />
                </button>
                <button type="button" onClick={() => moveTerm(row.id, 1)} disabled={i === letterTerms.length - 1}
                  className="rounded p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30" title="Move down">
                  <ChevronDown size={13} />
                </button>
              </div>
              <input
                className="w-36 shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold focus:border-blue-500 focus:outline-none sm:w-44"
                value={row.label} placeholder="Label"
                onChange={(e) => patchTerm(row.id, { label: e.target.value })}
              />
              <input
                className={INPUT_CLS} value={row.value} placeholder="Text printed on the letter"
                onChange={(e) => patchTerm(row.id, { value: e.target.value })}
              />
              <button type="button" onClick={() => removeTerm(row.id)}
                className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Remove this term">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {letterTerms.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-400">
              No term rows — the letter will show only the purchase price. Add rows below.
            </p>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {letterTerms.length < 7 ? (
            <button type="button" onClick={addTerm}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <Plus size={13} /> Add term (e.g. Inspection)
            </button>
          ) : (
            <p className="text-xs text-slate-400">Seven rows max — the letter runs out of room after that.</p>
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={resetTermsToTemplate}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
              title="Revert this offer's rows to your saved template (or the built-in defaults)">
              <RotateCcw size={12} /> Reset to template
            </button>
            <button type="button" onClick={saveTermsTemplate} disabled={tplSaving || !settings}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              title="Save these rows as the default template every new offer starts from">
              {tplSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {tplSaved ? "Template saved ✓" : "Save as default template"}
            </button>
          </div>
        </div>
      </div>

      {/* Sticky action bar: the live number + actions stay in reach while
          scrolling through comps and rehab above. */}
      <div className="sticky bottom-0 z-20 -mx-4 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto min-w-0">
            {calc ? (
              <>
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Cash offer</div>
                <div className="truncate text-lg font-black leading-tight tracking-tight">{fmtMoney(calc.offers.cash.amount)}</div>
                {ceiling && (
                  <div className={`truncate text-[11px] ${ceiling.over > 0 ? "font-semibold text-amber-700" : "text-slate-500"}`}
                    title={`${ceiling.pct}% × ARV − repairs = ${fmtMoney(ceiling.noFee)}; this offer + the ${fmtMoney(effSettings.wholesaleFee)} fee = ${fmtMoney(ceiling.ask)}${ceiling.note ? `. ${ceiling.note}` : ""}`}>
                    Buyer ceiling {fmtMoney(ceiling.noFee)} · offer + fee {ceiling.over > 0 ? `${fmtMoney(ceiling.over)} over` : `${fmtMoney(-ceiling.over)} under`}
                  </div>
                )}
              </>
            ) : (
              <span className="text-xs text-slate-400">Enter an ARV (or use comps) to see the offer.</span>
            )}
          </div>
          <button type="button" disabled={!calc || previewing} onClick={doPreview}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-40 hover:bg-slate-50">
            {previewing ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
            Preview document
          </button>
          {/* A held auto-underwrite you've priced: the bot can take it from
              here — float the number, or send the letter on a clean run. */}
          {row && !hasPaper(row) && row.autoUnderwrite && (
            <button type="button" disabled={!canSend || publishing} onClick={() => publish({ handToBot: true })}
              title="Make this the offer and let the bot float the number or send the letter, as it would after a clean underwrite"
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-40 hover:bg-slate-50">
              <Bot size={16} /> Let the bot take it
            </button>
          )}
          {/* The one way out. On a draft it makes the offer first — the same
              row, now with its letter — then opens the send window. */}
          <button type="button" disabled={!canSend || publishing} onClick={sendNow}
            title={hasPaper(row) ? "Text or email this offer to the agent" : "Make the offer and send it to the agent"}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40 hover:bg-blue-700">
            {publishing ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} Send
          </button>
        </div>
        {!canSend && calc && (
          <div className="mt-1 text-right text-xs text-slate-400">
            {!namesAHouse(inputs.address) ? "Add the house number and street to send." : "Pick the agent in step 1 (or enter a phone) to send."}
          </div>
        )}
        {hasPaper(row) && (row.sends || []).length > 0 && (
          <div className="mt-1 text-right text-xs text-slate-400">Live: the agent's link and the bot's number update as you type.</div>
        )}
      </div>

      {handed && (
        <div role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Handed to the bot — it floats the number or sends the letter, as after a clean underwrite.
        </div>
      )}
      {saveWarnings.length > 0 && (
        <ul className="list-inside list-disc rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {saveWarnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}

      {lastSend && (
        <div className="rounded-lg bg-emerald-100 px-3 py-2 text-sm font-medium text-emerald-800">
          Sent via {(lastSend.channels || []).map((c) => CHANNEL_LABELS[c] || c).join(" + ")} ✓
        </div>
      )}

      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {preview && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold">Document preview</h2>
            <button type="button" onClick={() => setPreview(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100">
              <X size={16} />
            </button>
          </div>
          <img src={preview} alt="Offer document preview" className="mx-auto w-full max-w-lg rounded-lg border border-slate-200 shadow" />
        </div>
      )}
    </div>

    {/* Right rail: the contact's GHL notes, always in view while underwriting. */}
    {mode === "existing" && contact?.id && (
      <aside className="hidden w-72 shrink-0 xl:block">
        <NotesPanel
          contactName={contact.name}
          notes={contactNotes}
          loading={notesLoading}
          error={notesError}
          onAdd={addNote}
          onEnrich={() => setEnrichOpen(true)}
        />
      </aside>
    )}
    {enrichOpen && contact?.id && (
      <EnrichModal contactId={contact.id} contactName={contact.name} defaultType="agent"
        onClose={() => setEnrichOpen(false)}
        onApplied={() => {
          // The summary lands as a note — refresh the panel.
          getContactNotes(contact.id).then((n) => n && setContactNotes(n)).catch(() => {});
        }} />
    )}

    {/* The same offer window the Offers tab opens, with the same verbs — the
        editor just supplies the agent's offers as its rail. */}
    {peek && (
      <OfferDetailModal
        offer={peek}
        siblings={agentBook}
        contactName={contact?.name}
        onSelect={setPeek}
        onClose={() => setPeek(null)}
        onEdit={onOpenOffer ? (o) => { setPeek(null); if (o.id !== fromOffer?.id) onOpenOffer(o); } : undefined}
        onSend={(o) => setPeekSub({ kind: "send", offer: o })}
        onPsa={(o) => setPeekSub({ kind: "psa", offer: o })}
        onContract={(o) => setPeekSub({ kind: "contract", offer: o })}
        onAssignment={(o) => setPeekSub({ kind: "assignment", offer: o })}
        onNetSheet={(o) => setPeekSub({ kind: "netsheet", offer: o })}
        onOfferPage={(o) => setPeekSub({ kind: "page", offer: o })}
        onPromote={onDeal ? promoteFromPeek : undefined}
        onStatus={changeOfferStatus}
        onRequote={requote} requoting={requoting}
        statusBusy={statusBusy}
        onDealNav={onDeal} />
    )}
    {/* Sending the offer that's open in the form (Send makes a draft the
        offer first, so by the time this opens there's paper to send). */}
    {sendOpen && fromOffer && (
      <SendModal offer={fromOffer} onClose={() => setSendOpen(false)}
        onSent={(id, sends, fields) => {
          setLastSend(sends?.[sends.length - 1] || { channels: [] });
          // The send lands on the record, so the copies the app is holding —
          // the agent's strip, the popout, History via onOfferSaved — have to
          // learn about it, and the row here moves to "sent".
          const updated = { ...fromOffer, sends, ...(fields || {}) };
          adopt(updated);
          setAgentOffers((list) => list.map((o) => (o.id === id ? { ...o, sends, ...(fields || {}) } : o)));
          onOfferSaved?.(updated);
        }} />
    )}
    {peekSub?.kind === "send" && (
      <SendModal offer={peekSub.offer} onClose={() => setPeekSub(null)}
        onSent={(id, sends, patch) => patchPeek({ ...peekSub.offer, sends, ...(patch || {}) })} />
    )}
    {peekSub?.kind === "psa" && (
      <PsaModal offer={peekSub.offer} settings={effSettings}
        onClose={() => setPeekSub(null)} onGenerated={patchPeek} />
    )}
    {peekSub?.kind === "contract" && (
      <ContractModal offer={peekSub.offer} settings={effSettings}
        onClose={() => setPeekSub(null)} onGenerated={patchPeek} />
    )}
    {peekSub?.kind === "assignment" && (
      <AssignmentModal offer={peekSub.offer} settings={effSettings}
        onClose={() => setPeekSub(null)} onGenerated={patchPeek} />
    )}
    {peekSub?.kind === "netsheet" && (
      <NetSheetModal offer={peekSub.offer} settings={effSettings}
        onClose={() => setPeekSub(null)} onGenerated={patchPeek} />
    )}
    {peekSub?.kind === "page" && (
      <OfferPageModal offer={peekSub.offer} onClose={() => setPeekSub(null)} />
    )}
    </div>
  );
}
