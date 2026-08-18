// ui.jsx — the primitives every table view in this app shares.
//
// Why this file exists: History, Deals, Agent Outreach and Dispositions each
// grew their own copy of the same search box, filter chips, KPI tiles, empty
// state and pill markup. Four copies means four slightly different paddings
// and, worse, four places to forget an aria-label. This is the one place those
// live now — the views compose, they don't re-draw.
//
// House style is unchanged: Tailwind class strings, no CSS files, dense
// spacing (design-system/offer-generator/MASTER.md, density 8/10) because
// these tables render inside a GHL iframe where vertical room is the scarce
// resource. Blue-600 is the action color.

import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Copy, Loader2, Search, X } from "lucide-react";
import {
  OFFER_STATUS, OFFER_STATUS_KEYS, SETTABLE_STATUSES, effectiveStatus, isExpired,
} from "@shared/offer-status.js";

/* ---------- button class strings ---------- */
// Hoisted rather than repeated inline, the same way SendModal.jsx does it.
export const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40";
export const BTN_PRIMARY = "inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40";
export const BTN_DANGER = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:opacity-40";
// Icon-only buttons: 28px minimum box so the tap target stays usable at this
// density. Short of the 44px guideline — a deliberate trade for a dense table
// inside an iframe, not an oversight.
export const BTN_ICON = "inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700";

/* ---------- pills ---------- */

export function Pill({ label, cls = "bg-slate-100 text-slate-600", small, title, children }) {
  return (
    <span title={title}
      className={`inline-flex items-center gap-1 rounded-full font-semibold ${cls} ${small ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"}`}>
      {children}
      {label}
    </span>
  );
}

// Deal stage. Lives here rather than in DealsView so History can show a stage
// without importing from a sibling view.
export const DEAL_STAGES = [
  { key: "under_contract", label: "Under contract", cls: "bg-amber-100 text-amber-800" },
  { key: "buyer_found", label: "Buyer found", cls: "bg-blue-100 text-blue-800" },
  { key: "assigned", label: "Assigned", cls: "bg-violet-100 text-violet-800" },
  { key: "closed", label: "Closed", cls: "bg-emerald-100 text-emerald-800" },
  { key: "fell_through", label: "Fell through", cls: "bg-slate-200 text-slate-600" },
];
export const STAGE = Object.fromEntries(DEAL_STAGES.map((s) => [s.key, s]));

export function StagePill({ stage, small }) {
  const s = STAGE[stage] || { label: stage, cls: "bg-slate-100 text-slate-600" };
  return <Pill label={s.label} cls={s.cls} small={small} />;
}

// Offer outcome. When the offer is a deal the deal stage is the truer label —
// "Accepted" and "Under contract" are the same fact, and the stage says more.
export function StatusPill({ offer, small }) {
  if (offer.deal) return <StagePill stage={offer.deal.stage} small={small} />;
  const key = effectiveStatus(offer);
  const s = OFFER_STATUS[key] || { label: key, cls: "bg-slate-100 text-slate-600" };
  const expired = isExpired(offer);
  return (
    <Pill label={s.label} cls={s.cls} small={small}
      title={expired ? "Past its expiry date — still waiting on a reply" : undefined}>
      {expired && <span className="text-[10px] font-bold opacity-60">⏱</span>}
    </Pill>
  );
}

// The CRM write can partially fail (fields saved, tag didn't). That's rare and
// not part of the daily read, so it shrinks to a warning glyph beside the
// status rather than owning a column of its own. Shared by the history table
// and the offer popout, which show the same fact in the same place.
export function AttachWarning({ offer }) {
  if (offer.status === "draft" || !offer.ghl) return null;
  if (offer.ghl.fields && offer.ghl.note && offer.ghl.tag) return null;
  return (
    <span className="ml-1 cursor-help text-amber-600" role="img"
      aria-label="Some CRM fields did not save"
      title={`Partially attached to the contact:\n${(offer.warnings || []).join("\n")}`}>
      ⚠
    </span>
  );
}

// The status pill as a control: click it, pick an outcome. This is the primary
// verb of the history table, so it sits in the row itself rather than behind an
// overflow menu — at ten offers a day, an extra click per row is the whole job.
export function StatusMenu({ offer, onSelect, busy, onDealNav }) {
  // A promoted offer's outcome is settled; the pill becomes a link to the deal.
  if (offer.deal) {
    return (
      <button type="button" onClick={(e) => { e.stopPropagation(); onDealNav?.(); }}
        aria-label={`Under contract — open the Deals tab`}>
        <StagePill stage={offer.deal.stage} small />
      </button>
    );
  }
  const current = effectiveStatus(offer);
  const items = SETTABLE_STATUSES.map((key) => ({
    key,
    label: key === "accepted" ? "Accepted → track as deal" : OFFER_STATUS[key].label,
    selected: key === current,
    onSelect: () => onSelect?.(key),
  }));
  return (
    <Menu align="left" label={`Change status (currently ${OFFER_STATUS[current]?.label || current})`}
      items={items}
      trigger={
        <span className="inline-flex items-center gap-0.5">
          {busy ? <Pill label="…" small /> : <StatusPill offer={offer} small />}
          <ChevronDown size={12} className="text-slate-400" aria-hidden="true" />
        </span>
      } />
  );
}

// A collapsed agent row still has to show whether anything under it is alive —
// one dot per offer, in funnel order, so eight offers read at a glance.
export function StatusDots({ offers }) {
  const counts = new Map();
  for (const o of offers) {
    const key = o.deal ? "accepted" : effectiveStatus(o);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const parts = OFFER_STATUS_KEYS.filter((k) => counts.has(k));
  if (!parts.length) return null;
  return (
    <span className="inline-flex items-center gap-1" aria-label={parts.map((k) => `${counts.get(k)} ${OFFER_STATUS[k].label}`).join(", ")}>
      {parts.map((k) => (
        <span key={k} className="inline-flex items-center gap-0.5" title={`${counts.get(k)} ${OFFER_STATUS[k].label}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${OFFER_STATUS[k].dot}`} aria-hidden="true" />
          {counts.get(k) > 1 && <span className="text-[10px] font-semibold text-slate-400">{counts.get(k)}</span>}
        </span>
      ))}
    </span>
  );
}

/* ---------- dropdown menu ---------- */

// One menu primitive for the whole app: closes on outside click and on Escape,
// moves focus with the arrow keys, and reports its state to screen readers.
// Written once here because every hand-rolled version forgets at least one of
// those four.
//
// The panel renders through a portal with fixed coordinates rather than as an
// absolutely-positioned child. It has to: these menus open inside TableCard,
// whose `overflow-x-auto` makes a scroll container on BOTH axes, so a normal
// absolute dropdown would be clipped by the table edge instead of overflowing
// it. Fixed + portal escapes that; the trade is repositioning on scroll/resize.
export function Menu({ trigger, items, align = "right", label = "Options" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [active, setActive] = useState(0);
  const wrapRef = useRef(null);
  const panelRef = useRef(null);
  const itemRefs = useRef([]);
  const menuId = useId();

  const place = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 176; // min-w-[11rem]
    const H = Math.min(items.length * 32 + 8, 320);
    // Flip up when there isn't room below, and never run off the right edge.
    const below = window.innerHeight - r.bottom;
    setPos({
      top: below < H + 8 && r.top > H ? r.top - H - 4 : r.bottom + 4,
      left: Math.max(8, Math.min(
        align === "right" ? r.right - W : r.left,
        window.innerWidth - W - 8,
      )),
    });
  };

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e) => {
      if (wrapRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") { setOpen(false); wrapRef.current?.querySelector("button")?.focus(); } };
    // Capture phase: an ancestor that scrolls (the table) doesn't bubble scroll.
    const onScroll = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useEffect(() => { if (open && pos) itemRefs.current[active]?.focus(); }, [open, pos, active]);

  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
  };

  return (
    <span ref={wrapRef} className="inline-block" onKeyDown={onKeyDown}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-label={label}
        onClick={(e) => { e.stopPropagation(); setActive(0); setOpen((v) => !v); }}>
        {trigger}
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} id={menuId} role="menu" style={{ top: pos.top, left: pos.left }}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 min-w-[11rem] rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {items.map((it, i) => (
            <button key={it.key ?? i} type="button" role="menuitem" disabled={it.disabled}
              ref={(el) => { itemRefs.current[i] = el; }}
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onSelect?.(); }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-40 ${
                it.danger ? "text-red-700 hover:bg-red-50" : "text-slate-700 hover:bg-slate-50"}`}>
              <span className="flex w-4 justify-center">{it.selected ? <Check size={13} /> : it.icon || null}</span>
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}

/* ---------- copy to clipboard ---------- */

// A link the operator has to be able to hand off. The confirmation matters more
// than it looks: without it there's no way to tell a successful copy from a
// clipboard permission that silently failed.
export function CopyButton({ value, label = "Copy link", className = BTN }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={className}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }).catch(() => {});
      }}>
      {done ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} aria-hidden="true" />}
      {done ? "Copied" : label}
    </button>
  );
}

/* ---------- search ---------- */

export function SearchInput({ value, onChange, placeholder = "Search…", className = "", label }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 ${className}`}>
      <Search size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        aria-label={label || placeholder} type="search"
        className="w-full bg-transparent text-sm focus:outline-none" />
      {value && (
        <button type="button" onClick={() => onChange("")} aria-label="Clear search"
          className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/* ---------- filter chips ---------- */

// options: [{ key, label, count? }]. Counts are what make these worth the
// space — "Passed 41" tells you something "Passed" alone doesn't.
export function FilterChips({ value, onChange, options, label = "Filter" }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      {options.map(({ key, label: text, count }) => {
        const on = value === key;
        return (
          <button key={key} type="button" onClick={() => onChange(key)} aria-pressed={on}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              on ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}>
            {text}
            {count != null && (
              <span className={`ml-1.5 tabular-nums ${on ? "text-blue-100" : "text-slate-400"}`}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- KPI tiles ---------- */

// items: [{ label, value, hint? }]
export function KpiRow({ items, cols = "sm:grid-cols-4" }) {
  return (
    <div className={`grid grid-cols-2 gap-2 ${cols}`}>
      {items.map((k) => (
        <div key={k.label} className="rounded-xl border border-slate-200 bg-white px-3 py-2" title={k.hint}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{k.label}</div>
          <div className="text-lg font-bold tabular-nums">{k.value}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- containers & states ---------- */

export function TableCard({ children }) {
  return <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">{children}</div>;
}

// An empty state that only says "nothing here" wastes the moment — pass an
// action whenever there is a sensible next move.
export function EmptyState({ children, action }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">
      <div>{children}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// Skeleton rows beat a lone spinner: the table's shape appears immediately, so
// nothing jumps when the data lands.
export function SkeletonRows({ cols = 6, rows = 6 }) {
  return (
    <TableCard>
      <table className="w-full text-sm">
        <tbody aria-busy="true" aria-label="Loading">
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r} className="border-b border-slate-100 last:border-0">
              {Array.from({ length: cols }).map((__, c) => (
                <td key={c} className="px-4 py-3">
                  <div className="h-3 animate-pulse rounded bg-slate-100" style={{ width: `${c === 0 ? 70 : 40 + ((r + c) % 3) * 15}%` }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

export function Spinner({ className = "" }) {
  return (
    <div className={`flex justify-center p-10 ${className}`} role="status" aria-label="Loading">
      <Loader2 className="animate-spin text-slate-400" />
    </div>
  );
}

export function ErrorBar({ children }) {
  return <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{children}</div>;
}

/* ---------- keyboard-operable table rows ---------- */

// A <tr> with an onClick is invisible to the keyboard. This gives it a role,
// a tab stop, and Enter/Space activation — the same affordances a button has.
export function rowActivation(onActivate) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // Let the real control handle it when focus is on a nested button/link.
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      onActivate?.(e);
    },
  };
}
