// PipelineBoard.jsx — one card per property, in the lane it currently sits.
//
// Acquisition on the left, disposition on the right, a divider between. The
// whole board scrolls sideways inside its own box so the page never does.
// A card opens in place to show that property's parked drafts and the quick
// ops the queue already offered for it — the same buttons, no second way.

import React, { useState } from "react";
import { AGENT_LANES, DISPO_LANES, HIDDEN_LANES } from "@shared/pipeline.js";
import { BTN, BTN_DANGER, BTN_PRIMARY, Pill, rowActivation } from "./ui.jsx";
import { DraftRow } from "./ConversationOutbox.jsx";
import ContactLink from "./ContactLink.jsx";
import { CONFIRM, describeResult, linkFor, runOp } from "./pipeline-ops.js";

const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
const TONE = {
  neutral: "bg-slate-100 text-slate-600",
  warn: "bg-amber-100 text-amber-800",
  bad: "bg-rose-100 text-rose-700",
  good: "bg-emerald-100 text-emerald-700",
};
// Buyer state on a deal card. Same colours the Deals page uses for the three
// statuses it knows; the three colder states are new here.
const BUYER = {
  committed: "bg-emerald-500", evaluating: "bg-blue-500", passed: "bg-rose-400",
  opened: "bg-violet-500", sent: "bg-sky-400", blasted: "bg-slate-300",
};
const BUYER_WORD = { committed: "committed", evaluating: "evaluating", passed: "passed", opened: "opened it", sent: "got the link", blasted: "blasted" };

function QuickOp({ op, item, onDone }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const href = linkFor(op.key, item);
  if (href) return <a href={href} target="_blank" rel="noreferrer" className={op.intent === "primary" ? BTN_PRIMARY : BTN}>{op.label}</a>;
  const cls = op.intent === "danger" ? BTN_DANGER : op.intent === "primary" ? BTN_PRIMARY : BTN;
  async function go(e) {
    e.stopPropagation();
    if (CONFIRM[op.key] && !window.confirm(CONFIRM[op.key](item))) return;
    setBusy(true); setNote("");
    try { setNote(describeResult(op.key, await runOp(op.key, item))); onDone?.(); }
    catch (err) { setNote(err.message || "That didn't work."); }
    finally { setBusy(false); }
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" className={cls} disabled={busy} onClick={go}>{busy ? "…" : op.label}</button>
      {note && <span className="text-[11px] text-slate-500">{note}</span>}
    </span>
  );
}

function PipelineCard({ card, actionsById, draftsById, expanded, onToggle, sendsEnabled, serverOffsetMs, onDone }) {
  const mine = card.actionIds.map((id) => actionsById[id]).filter(Boolean);
  const urgent = mine.some((a) => a.severity === "now");
  const soon = !urgent && mine.some((a) => a.severity === "soon");
  // The quick ops: every op the queue offered on this card, once per key.
  const ops = new Map();
  for (const a of mine) for (const op of a.ops || []) if (!ops.has(op.key) && op.key !== "show_draft") ops.set(op.key, { op, item: a });
  const drafts = card.draftIds.map((id) => draftsById[id]).filter(Boolean);
  const isJob = card.kind === "job";

  return (
    <div
      {...rowActivation(onToggle)}
      className={`relative cursor-pointer rounded-xl border bg-white p-3 text-sm shadow-sm transition hover:shadow ${expanded ? "border-blue-300" : "border-slate-200"} ${card.side === "dispo" ? "border-l-4 border-l-emerald-400" : "border-l-4 border-l-blue-400"}`}
      aria-expanded={expanded}
    >
      {(urgent || soon) && <span className={`absolute right-2 top-2 h-2.5 w-2.5 rounded-full ${urgent ? "bg-rose-500" : "bg-amber-400"}`} title={urgent ? "needs you now" : "needs you soon"} />}
      <div className="flex items-baseline justify-between gap-2 pr-3">
        <div className="truncate font-semibold text-slate-900" title={card.address}>{card.address || "no address yet"}</div>
        <div className="shrink-0 text-xs tabular-nums text-slate-400">{card.ageDays}d</div>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="truncate">
          {card.contactId
            ? <ContactLink contactId={card.contactId} name={card.contactName || "contact"} party={card.side === "dispo" ? "agent" : "agent"} stopPropagation />
            : card.contactName || "—"}
        </span>
        {card.cashAmount > 0 && <span className="shrink-0 font-medium tabular-nums text-slate-700">{money(card.cashAmount)}</span>}
      </div>
      {card.chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {card.chips.map((c) => <Pill key={c.key} small label={c.label} cls={TONE[c.tone] || TONE.neutral} />)}
        </div>
      )}
      {card.deal && (
        <div className="mt-2 flex flex-wrap items-center gap-1" title="buyers on this deal">
          {card.deal.investors.length === 0
            ? <span className="text-[11px] text-slate-400">nobody on it yet</span>
            : card.deal.investors.map((i) => (
              <span key={i.contactId} className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-700" title={`${i.name}: ${BUYER_WORD[i.state] || i.state}${i.viewCount ? ` ×${i.viewCount}` : ""}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${BUYER[i.state] || BUYER.blasted}`} />
                {i.name}
              </span>
            ))}
          {card.deal.assignmentFee > 0 && <span className="ml-auto text-[11px] text-slate-500">fee {money(card.deal.assignmentFee)}</span>}
        </div>
      )}

      {expanded && (
        <div className="mt-3 border-t border-slate-100 pt-3" onClick={(e) => e.stopPropagation()}>
          {isJob ? (
            <p className="text-xs text-slate-500">The robot is on it — {card.chips[0]?.label}. It lands in the book when it's done.</p>
          ) : (
            <>
              {ops.size > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {[...ops.values()].map(({ op, item }) => <QuickOp key={op.key} op={op} item={item} onDone={onDone} />)}
                </div>
              )}
              {drafts.length > 0 && (
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
                  {drafts.map((d) => <DraftRow key={d.id} draft={d} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} onDone={onDone} />)}
                </ul>
              )}
              {!ops.size && !drafts.length && <p className="text-xs text-slate-400">Nothing waiting here.</p>}
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {card.offerId && <a className="text-blue-700 hover:underline" href={linkFor("open_editor", card)} target="_blank" rel="noreferrer">Open the offer</a>}
                {card.deal && <a className="text-blue-700 hover:underline" href={linkFor("open_deals", card)} target="_blank" rel="noreferrer">Open the deal</a>}
                {card.deadReason === "fell_through" && card.offerId && <a className="text-rose-700 hover:underline" href={`${linkFor("open_deals", card)}&deal_id=${encodeURIComponent(card.offerId)}&postmortem=1`} target="_blank" rel="noreferrer">Post-mortem</a>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LaneColumn({ lane, cards, ...rest }) {
  return (
    <div className="w-64 shrink-0">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500" title={lane.hint}>{lane.label}</div>
        <div className="text-xs tabular-nums text-slate-400">{cards.length}</div>
      </div>
      <div className="space-y-2">
        {cards.length === 0
          ? <div className="rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-300">—</div>
          : cards.map((c) => <PipelineCard key={c.id} card={c} {...rest} expanded={rest.expandedId === c.id} onToggle={() => rest.setExpandedId(rest.expandedId === c.id ? null : c.id)} />)}
      </div>
    </div>
  );
}

export default function PipelineBoard({ cards = [], actions = [], drafts = [], showHidden = false, sendsEnabled, serverOffsetMs, onDone, expandedId, setExpandedId }) {
  const actionsById = Object.fromEntries(actions.map((a) => [a.id, a]));
  const draftsById = Object.fromEntries(drafts.map((d) => [d.id, d]));
  const byLane = (key) => cards.filter((c) => c.lane === key);
  const shared = { actionsById, draftsById, sendsEnabled, serverOffsetMs, onDone, expandedId, setExpandedId };
  const dispo = showHidden ? DISPO_LANES : DISPO_LANES.filter((l) => !l.hidden);
  const hidden = showHidden ? HIDDEN_LANES : [];
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max gap-3">
        <div className="flex gap-3 rounded-2xl bg-blue-50/40 p-3">
          <div className="-mr-1 w-5 shrink-0 [writing-mode:vertical-rl] rotate-180 text-center text-[11px] font-semibold uppercase tracking-widest text-blue-400">Acquisition</div>
          {AGENT_LANES.map((l) => <LaneColumn key={l.key} lane={l} cards={byLane(l.key)} {...shared} />)}
        </div>
        <div className="flex gap-3 rounded-2xl bg-emerald-50/40 p-3">
          <div className="-mr-1 w-5 shrink-0 [writing-mode:vertical-rl] rotate-180 text-center text-[11px] font-semibold uppercase tracking-widest text-emerald-500">Disposition</div>
          {dispo.map((l) => <LaneColumn key={l.key} lane={l} cards={byLane(l.key)} {...shared} />)}
        </div>
        {hidden.length > 0 && (
          <div className="flex gap-3 rounded-2xl bg-slate-100/60 p-3">
            {hidden.map((l) => <LaneColumn key={l.key} lane={l} cards={byLane(l.key)} {...shared} />)}
          </div>
        )}
      </div>
    </div>
  );
}
