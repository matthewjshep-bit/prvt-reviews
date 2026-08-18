// NewOffer.jsx — the core flow: contact → property numbers → three live
// offers → generate the document and attach everything to the GHL contact.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, ExternalLink, FileText, Layers, Link2, Loader2, Maximize2, Plus, RotateCcw, Save, Search, Send, Trash2, X } from "lucide-react";
import { calculateOffers, DEFAULT_OFFER_SETTINGS, fmtMoney, UNDERWRITE_MODES } from "@shared/offer-calc.js";
import {
  addContactNote, createOffer, getContactDetail, getContactNotes, ghlContactUrl, listOffers,
  previewDocument, promoteDeal, saveDraft, saveSettings, searchContacts, suggestAddresses, zillowUrl,
} from "./api.js";
import CompsPane from "./CompsPane.jsx";
import RehabPane from "./RehabPane.jsx";
import NotesPanel from "./NotesPanel.jsx";
import SendModal, { CHANNEL_LABELS } from "./SendModal.jsx";
import ContractModal from "./ContractModal.jsx";
import AssignmentModal from "./AssignmentModal.jsx";
import NetSheetModal from "./NetSheetModal.jsx";
import EnrichModal from "./EnrichModal.jsx";
import OfferPageModal from "./OfferPageModal.jsx";
import OfferDetailModal from "./OfferDetailModal.jsx";
import { StatusPill } from "./ui.jsx";

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
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

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

export default function NewOffer({ settings, initialContactId, restore, onReset, onSettingsSaved, onOpenOffer, onDeal }) {
  // `restore` reopens a saved draft or an existing offer. Both carry a full
  // form snapshot (drafts in .draft, created offers in .snapshot) so the
  // comps workspace and rehab scope come back exactly as they were; very old
  // offers without a snapshot fall back to deriving inputs from the calc.
  const snap = restore?.status === "draft" ? restore.draft : restore?.snapshot || null;
  const fromOffer = restore && restore.status !== "draft" ? restore : null;
  const fmtN = (n) => (Number(n) ? Number(n).toLocaleString("en-US") : "");

  const [mode, setMode] = useState(snap?.mode || "existing");
  const [contact, setContact] = useState(
    snap?.contact ||
    (fromOffer?.contactId ? { id: fromOffer.contactId, name: fromOffer.contactName || "", phone: "", email: "" } : null)
  );
  const [newContact, setNewContact] = useState(snap?.newContact || { name: "", phone: "" });
  const BLANK_INPUTS = { address: "", askingPrice: "", arv: "", repairs: "", priceOverride: "" };
  const [inputs, setInputs] = useState(
    snap?.inputs ? { ...BLANK_INPUTS, ...snap.inputs } :
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
  useEffect(() => {
    if (termsTouchedRef.current || !settings) return;
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
  const [scope, setScope] = useState(snap?.scope || fromOffer?.scope || []); // applied rehab line items
  const [draftId, setDraftId] = useState(restore?.status === "draft" ? restore.id : null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const rehabStateRef = useRef(snap?.rehab || null);
  const compsStateRef = useRef(snap?.comps || null);
  const rehabInit =
    snap?.rehab ||
    (fromOffer?.scope?.length
      ? { custom: fromOffer.scope.map((s, i) => ({ id: `c-${i}`, label: s.label, cost: s.cost })) }
      : undefined);
  const compsInit = snap?.comps || undefined;
  const [preview, setPreview] = useState(null);   // data-url image
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);     // { offer, ghl, warnings }
  const [error, setError] = useState("");
  const [sendOpen, setSendOpen] = useState(false); // SendModal (text and/or email via GHL)
  const [contractOpen, setContractOpen] = useState(false); // ContractModal (purchase & sale PDF)
  const [assignmentOpen, setAssignmentOpen] = useState(false); // AssignmentModal (dispositions PDF)
  const [netSheetOpen, setNetSheetOpen] = useState(false); // NetSheetModal (seller net comparison)
  const [offerPageOpen, setOfferPageOpen] = useState(false); // OfferPageModal (agent-facing page)
  const [enrichOpen, setEnrichOpen] = useState(false); // EnrichModal (AI conversation → CRM fields)
  const [lastSend, setLastSend] = useState(null);  // most recent send record, for the ✓ banner

  // Everything this agent has been offered, and the popout over it. The
  // editor is where you underwrite ONE property, but the question "what else
  // is open with this agent" arrives mid-underwrite — so their offers sit in a
  // strip above the form and open the same detail window the Offers tab uses.
  const [agentOffers, setAgentOffers] = useState([]);
  const [peek, setPeek] = useState(null);        // offer whose popout is open
  const [peekSub, setPeekSub] = useState(null);  // { kind, offer } layered over it

  useEffect(() => {
    const id = contact?.id;
    if (!id) { setAgentOffers([]); return; }
    let live = true;
    // Drafts are excluded: they have no document to look at, and the strip is
    // for what actually went out.
    listOffers({ contactId: id, limit: 50 })
      .then((list) => { if (live) setAgentOffers((list || []).filter((o) => o.status !== "draft")); })
      .catch(() => { /* the strip is a convenience — never block the form */ });
    return () => { live = false; };
  }, [contact?.id]);

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

  // One patcher for every copy of an offer the popout is holding.
  const patchPeek = (updated) => {
    if (!updated) return;
    setPeek((p) => (p && p.id === updated.id ? updated : p));
    setPeekSub((s) => (s && s.offer.id === updated.id ? { ...s, offer: updated } : s));
    setAgentOffers((list) => list.map((o) => (o.id === updated.id ? updated : o)));
  };

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
        const addr = pickContactAddress(d.custom);
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
        const addr = pickContactAddress(d.custom);
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
      return calculateOffers(inputs, effSettings);
    } catch {
      return null;
    }
  }, [inputs, effSettings]);

  const contactName = mode === "existing" ? contact?.name || "" : newContact.name;
  const canCreate = Boolean(calc && (mode === "existing" ? contact?.id : newContact.phone.trim()));

  async function doPreview() {
    setError(""); setPreviewing(true);
    try {
      const r = await previewDocument(inputs, effSettings, contactName);
      setPreview(r.image);
    } catch (e) { setError(e.message); }
    setPreviewing(false);
  }

  async function doCreate() {
    setError(""); setCreating(true); setLastSend(null);
    try {
      const r = await createOffer({
        contactId: mode === "existing" ? contact?.id : undefined,
        newContact: mode === "new" ? newContact : undefined,
        inputs,
        settings: effSettings,
        scope,
        draftId,
        // Full form snapshot so History → Edit restores comps + rehab intact.
        snapshot: {
          mode, contact, newContact, inputs, subjectSqft, subjectInfo, scope, underwriteMode, feeOverride, uwOverrides, letterTerms, offerExpires,
          rehab: rehabStateRef.current,
          comps: compsStateRef.current,
        },
      });
      setResult(r);
      setPreview(null);
      setDraftId(null);
    } catch (e) { setError(e.message); }
    setCreating(false);
  }

  const draftBody = () => ({
    mode, contact, newContact, inputs, subjectSqft, subjectInfo, scope, underwriteMode, feeOverride, uwOverrides, letterTerms, offerExpires,
    rehab: rehabStateRef.current,
    comps: compsStateRef.current,
    cashPreview: calc?.offers?.cash?.amount ?? null,
  });

  async function doSaveDraft() {
    setError(""); setSavingDraft(true);
    try {
      const r = await saveDraft(draftId, draftBody());
      setDraftId(r.offer.id);
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 2500);
    } catch (e) { setError(e.message); }
    setSavingDraft(false);
  }

  /* ---------- draft autosave ---------- */
  // Comps claimed off Zillow are read-and-delete on the server: the instant the
  // comps pane claims them they exist nowhere but this component's state. So
  // switching to History — which unmounts this form — used to destroy them for
  // good, and the only defense was remembering to press "Save draft". Now any
  // work that couldn't be reconstructed schedules a draft write on its own.
  //
  // Deliberately not a save-everything-on-every-keystroke autosave: a draft
  // holding nothing but a half-typed address is clutter in the History tab, so
  // hasWorkToLose() gates it on something that would actually hurt to lose.
  const autosaveTimer = useRef(null);
  const autosaveInFlight = useRef(false);
  const autosaveQueued = useRef(false);
  const mountedRef = useRef(true);
  // Everything the flush reads goes through a ref: the unmount handler runs
  // from a `[]`-deps effect, so a plain closure there would see first-render
  // values and happily write a draft for an offer that has since been created.
  const draftIdRef = useRef(draftId);
  const draftBodyRef = useRef(draftBody);
  const blockAutosave = useRef(false);
  draftBodyRef.current = draftBody;
  blockAutosave.current = Boolean(result) || creating;
  useEffect(() => { draftIdRef.current = draftId; }, [draftId]);

  // Comps that can't be re-fetched, or a rehab scope built by hand.
  const hasWorkToLose = (body) => {
    const c = body.comps || {};
    return Boolean(
      (c.captured || []).length || (c.manual || []).length ||
      (c.selected || []).length || (body.scope || []).length
    );
  };

  async function flushDraft() {
    if (blockAutosave.current) return;
    const body = draftBodyRef.current();
    if (!String(body.inputs?.address || "").trim() || !hasWorkToLose(body)) return;
    // One write at a time. Two in flight would each create a draft row, and
    // doCreate only ever consumes the one id it holds.
    if (autosaveInFlight.current) { autosaveQueued.current = true; return; }
    autosaveInFlight.current = true;
    try {
      const r = await saveDraft(draftIdRef.current, body);
      if (r?.offer?.id && r.offer.id !== draftIdRef.current) {
        draftIdRef.current = r.offer.id;
        if (mountedRef.current) setDraftId(r.offer.id);
      }
      if (mountedRef.current) {
        setDraftSaved(true);
        setTimeout(() => { if (mountedRef.current) setDraftSaved(false); }, 2500);
      }
    } catch { /* a safety net, not a user action — never interrupt with an error */ }
    autosaveInFlight.current = false;
    if (autosaveQueued.current) { autosaveQueued.current = false; flushDraft(); }
  }

  function scheduleDraftSave() {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => { autosaveTimer.current = null; flushDraft(); }, 1500);
  }

  // Both panes report their state once on mount — that first emission is the
  // restored workspace echoing back, not work anybody did. Autosaving it would
  // mint a draft row every time you opened an existing offer just to look at
  // it, so the first report from each pane only updates the ref.
  const firstReport = useRef({ comps: true, rehab: true });
  const reportPaneState = (which, ref) => (s) => {
    ref.current = s;
    if (firstReport.current[which]) { firstReport.current[which] = false; return; }
    scheduleDraftSave();
  };

  useEffect(() => {
    mountedRef.current = true;
    // Backgrounding the tab is the other moment a pending timer would be lost.
    const onHide = () => { if (document.visibilityState === "hidden") flushDraft(); };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      mountedRef.current = false;
      // Leaving the form is exactly when the debounce would otherwise be
      // thrown away — fire the pending write instead of clearing it.
      if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); flushDraft(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (result) {
    const { offer, ghl, warnings } = result;
    const Badge = ({ ok, label }) => (
      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
        ok ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
      }`}>
        {ok ? <Check size={12} /> : <X size={12} />} {label}
      </span>
    );
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
          <div className="text-sm font-bold text-emerald-900">
            Offer created for{" "}
            {offer.contactId ? (
              <a href={ghlContactUrl(offer.contactId)} target="_blank" rel="noreferrer" title="Open contact in GHL"
                className="inline-flex items-center gap-1 underline hover:text-emerald-700">
                {offer.contactName || "contact"} <ExternalLink size={12} />
              </a>
            ) : (
              offer.contactName || "contact"
            )}{" "}
            — {offer.address || "property"}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge ok={ghl.fields} label="Custom fields" />
            <Badge ok={ghl.note} label="Contact note" />
            <Badge ok={ghl.tag} label="Tag" />
          </div>
          {warnings?.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-xs text-amber-800">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <img src={offer.imageUrl} alt="Offer document" className="w-full rounded-xl border border-slate-200 shadow-sm" />
          <div className="space-y-3">
            <button type="button" onClick={() => setOfferPageOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
              title="One shareable web page for the agent: the offer, the comps, the scope and the seller's net">
              <Link2 size={16} /> Share an offer page with the agent
            </button>
            <a href={offer.pdfUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
              <FileText size={16} /> Open PDF document
            </a>
            {offer.scopePdfUrl && (
              <a href={offer.scopePdfUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
                <FileText size={16} /> Open Rehab Scope of Work (PDF)
              </a>
            )}
            {offer.compsPdfUrl && (
              <a href={offer.compsPdfUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
                <FileText size={16} /> Open Comps / ARV Analysis (PDF)
              </a>
            )}
            <a href={offer.imageUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
              <FileText size={16} /> Open image version
            </a>
            {offer.contractPdfUrl && (
              <a href={offer.contractPdfUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
                <FileText size={16} /> Open Purchase Contract (PDF)
              </a>
            )}
            <button type="button" onClick={() => setNetSheetOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
              title="One-pager: our offer with no buyer's commission vs. the list price needed to net the same">
              <FileText size={16} /> {offer.netSheetPdfUrl ? "Seller net comparison" : "Generate seller net comparison"}
            </button>
            <button type="button" onClick={() => setContractOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
              <FileText size={16} /> {offer.contractPdfUrl ? "Update purchase contract" : "Generate purchase contract"}
            </button>
            <button type="button" onClick={() => setSendOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
              <Send size={16} /> Send to the contact — text or email
            </button>
            <div className="pt-1">
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Dispositions — for the end buyer, not the seller
              </div>
              {offer.assignmentPdfUrl && (
                <a href={offer.assignmentPdfUrl} target="_blank" rel="noreferrer"
                  className="mb-3 flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
                  <FileText size={16} /> Open Assignment Contract (PDF)
                </a>
              )}
              <button type="button" onClick={() => setAssignmentOpen(true)}
                className="flex w-full items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
                <FileText size={16} /> {offer.assignmentPdfUrl ? "Update assignment contract" : "Generate assignment contract"}
              </button>
            </div>
            {lastSend && (
              <div className="rounded-lg bg-emerald-100 px-3 py-2 text-sm font-medium text-emerald-800">
                Sent via {(lastSend.channels || []).map((c) => CHANNEL_LABELS[c] || c).join(" + ")} ✓
              </div>
            )}
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div className="flex flex-wrap gap-4">
              <button type="button" onClick={() => (onReset ? onReset() : (setResult(null), setLastSend(null), setError("")))}
                className="text-sm font-medium text-slate-500 underline hover:text-slate-800">
                Start another offer
              </button>
              <button type="button" onClick={() => { setResult(null); setLastSend(null); setError(""); }}
                className="text-sm font-medium text-slate-500 underline hover:text-slate-800">
                Back to this offer's form
              </button>
            </div>
          </div>
        </div>

        {sendOpen && (
          <SendModal
            offer={offer}
            onClose={() => setSendOpen(false)}
            onSent={(id, sends) => setLastSend(sends?.[sends.length - 1] || { channels: [] })}
          />
        )}
        {contractOpen && (
          <ContractModal
            offer={offer}
            settings={effSettings}
            onClose={() => setContractOpen(false)}
            onGenerated={(o) => setResult((r) => ({ ...r, offer: o }))}
          />
        )}
        {assignmentOpen && (
          <AssignmentModal
            offer={offer}
            settings={effSettings}
            onClose={() => setAssignmentOpen(false)}
            onGenerated={(o) => setResult((r) => ({ ...r, offer: o }))}
          />
        )}
        {netSheetOpen && (
          <NetSheetModal
            offer={offer}
            settings={effSettings}
            onClose={() => setNetSheetOpen(false)}
            onGenerated={(o) => setResult((r) => ({ ...r, offer: o }))}
          />
        )}
        {offerPageOpen && <OfferPageModal offer={offer} onClose={() => setOfferPageOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-5">
    <div className="min-w-0 flex-1 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold tracking-tight">
            {restore ? (restore.status === "draft" ? "Editing draft" : "Editing offer") : "New cash offer"}
          </h1>
          <p className="text-xs text-slate-500">
            {restore
              ? `${restore.address || "restored from History"} — clearing starts a fresh offer`
              : "Work top to bottom: contact → property → comps → rehab → offer."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The editor shows the working copy; this is the offer as it went
              out — the document, what was sent, what came back, and every
              action that follows it. */}
          {fromOffer && (
            <button type="button" onClick={() => setPeek(agentOffers.find((o) => o.id === fromOffer.id) || fromOffer)}
              title="Open the full offer window — document, send history, contract and offer page"
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Maximize2 size={14} /> Offer details
            </button>
          )}
          <button type="button"
            onClick={() => { if (window.confirm("Clear the whole form and start a fresh offer?")) onReset?.(); }}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900">
            <RotateCcw size={14} /> Clear form
          </button>
        </div>
      </div>

      <AgentOfferTabs offers={agentOffers} currentId={fromOffer?.id}
        contactName={contact?.name} onOpen={setPeek} />

      <ContactPicker
        selected={contact} onSelect={selectContact}
        newContact={newContact} setNewContact={setNewContact}
        mode={mode} setMode={setMode}
        notes={contactNotes}
      />

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold"><StepBadge n={2} /> Property</h2>
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
          </div>
          <Field label="After-repair value / ARV ($)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.arv} onChange={setMoney("arv")} placeholder="from comps below" />
          </Field>
          <Field label="Estimated repairs ($)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.repairs} onChange={setMoney("repairs")} placeholder="from scope below" />
          </Field>
          <Field label="Asking price ($, optional)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.askingPrice} onChange={setMoney("askingPrice")} placeholder="for %-of-asking context" />
          </Field>
        </div>
      </div>

      <CompsPane
        address={inputs.address}
        sqft={subjectSqft}
        setSqft={setSubjectSqft}
        onSubjectInfo={setSubjectInfo}
        initialState={compsInit}
        onStateChange={reportPaneState("comps", compsStateRef)}
        onUseArv={(arv) => setInputs((s) => ({ ...s, arv: Number(arv).toLocaleString("en-US") }))}
      />

      <RehabPane
        sqft={subjectSqft}
        beds={Number(subjectInfo?.beds) || 0}
        baths={Number(subjectInfo?.baths) || 0}
        yearBuilt={Number(subjectInfo?.yearBuilt) || 0}
        address={inputs.address}
        initialState={rehabInit}
        onStateChange={reportPaneState("rehab", rehabStateRef)}
        onApply={(total, lines) => {
          setInputs((s) => ({ ...s, repairs: Number(total).toLocaleString("en-US") }));
          setScope(lines);
        }}
      />

      <OfferCards calc={calc} underwriteMode={underwriteMode} setUnderwriteMode={setUnderwriteMode}
        priceOverride={inputs.priceOverride || ""} setPriceOverride={(v) => setInputs((s) => ({ ...s, priceOverride: v }))}
        feeOverride={feeOverride} setFeeOverride={setFeeOverride}
        uwOverrides={uwOverrides} setUw={setUw} settings={settings} fmtTyped={fmtTyped} />

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
          <button type="button" disabled={savingDraft} onClick={doSaveDraft}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-40 hover:bg-slate-50">
            {savingDraft ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {draftSaved ? "Draft saved ✓" : draftId ? "Update draft" : "Save draft"}
          </button>
          <button type="button" disabled={!canCreate || creating} onClick={doCreate}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40 hover:bg-blue-700">
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
            Create offer & attach to contact
          </button>
        </div>
        {!canCreate && calc && (
          <div className="mt-1 text-right text-xs text-slate-400">Pick a contact in step 1 (or enter a phone) to create the offer.</div>
        )}
      </div>

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
        siblings={agentOffers}
        contactName={contact?.name}
        onSelect={setPeek}
        onClose={() => setPeek(null)}
        onEdit={onOpenOffer ? (o) => { setPeek(null); if (o.id !== fromOffer?.id) onOpenOffer(o); } : undefined}
        onSend={(o) => setPeekSub({ kind: "send", offer: o })}
        onContract={(o) => setPeekSub({ kind: "contract", offer: o })}
        onAssignment={(o) => setPeekSub({ kind: "assignment", offer: o })}
        onNetSheet={(o) => setPeekSub({ kind: "netsheet", offer: o })}
        onOfferPage={(o) => setPeekSub({ kind: "page", offer: o })}
        onPromote={onDeal ? promoteFromPeek : undefined}
        onDealNav={onDeal} />
    )}
    {peekSub?.kind === "send" && (
      <SendModal offer={peekSub.offer} onClose={() => setPeekSub(null)}
        onSent={(id, sends, patch) => patchPeek({ ...peekSub.offer, sends, ...(patch || {}) })} />
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
