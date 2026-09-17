// CoachCard.jsx — "Learned last night": what the nightly coach thinks the bot
// should pick up from the drafts you edited, dismissed or answered yourself.
//
// Nothing on this card has happened yet. A proposal changes the bot only when
// you press Apply, and Revert takes exactly that change back. The card keeps
// its own state so Today doesn't have to know about it.

import React, { useEffect, useRef, useState } from "react";
import { COACH_KIND_LABEL } from "@shared/coach.js";
import { actOnCoachProposal, getCoach, previewCoachProposal, runCoach } from "./api.js";
import { BTN, BTN_PRIMARY, Pill } from "./ui.jsx";

const KIND_CLS = {
  example: "bg-sky-100 text-sky-800", rule: "bg-violet-100 text-violet-800",
  instruction: "bg-indigo-100 text-indigo-800", code_gap: "bg-amber-100 text-amber-800",
};
const when = (v) => (v ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

// What the proposal would put in front of the bot, shown the way it will read.
export function ProposalBody({ p }) {
  if (p.kind === "example") {
    return (
      <div className="mt-1.5 space-y-1 text-sm">
        <div className="text-slate-500"><span className="text-xs font-semibold uppercase tracking-wide text-slate-400">They said</span> {p.theySaid}</div>
        <div className="text-slate-800"><span className="text-xs font-semibold uppercase tracking-wide text-slate-400">You said</span> {p.weSay}</div>
      </div>
    );
  }
  if (p.kind === "code_gap") {
    return (
      <div className="mt-1.5 space-y-1 text-sm text-slate-800">
        <div className="font-medium">{p.title}</div>
        {p.suspectedArea && <div className="text-xs text-slate-500">Likely in: {p.suspectedArea}</div>}
        {p.suggestedTest && <div className="text-xs text-slate-500">A test that should fail today: {p.suggestedTest}</div>}
      </div>
    );
  }
  return <div className="mt-1.5 text-sm text-slate-800">{p.text}</div>;
}

const SCORE = {
  better: ["bg-emerald-100 text-emerald-800", "sent as written more often since"],
  worse: ["bg-rose-100 text-rose-700", "sent as written less often since — worth a look"],
  same: ["bg-slate-100 text-slate-600", "no real change since"],
  too_early: ["bg-slate-100 text-slate-500", "too early to say"],
};

function Row({ p, canFile, onDone }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const act = async (verb) => {
    setBusy(verb); setError("");
    try { await actOnCoachProposal(p.id, verb); onDone?.(); }
    catch (e) { setError(e.message || "That didn't work."); }
    setBusy("");
  };
  const [preview, setPreview] = useState(null);
  const tryIt = async () => {
    setBusy("preview"); setError("");
    try { setPreview(await previewCoachProposal(p.id)); }
    catch (e) { setError(e.message || "That didn't work."); }
    setBusy("");
  };
  const card = p.scorecard;
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Pill small label={COACH_KIND_LABEL[p.kind] || p.kind} cls={KIND_CLS[p.kind]} />
        {p.party && p.party !== "any" && <span className="text-xs text-slate-400">{p.party}{p.intent ? ` · ${p.intent.replace(/_/g, " ")}` : ""}</span>}
        {p.replaces && <span className="text-xs text-slate-400">replaces an existing one</span>}
      </div>
      <ProposalBody p={p} />
      <div className="mt-1 text-xs text-slate-500">Why: {p.why}{p.evidence?.length ? ` · from ${p.evidence.length} draft${p.evidence.length === 1 ? "" : "s"}` : ""}</div>
      {p.status === "applied" && card && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <Pill small label={SCORE[card.verdict]?.[1] || card.verdict} cls={SCORE[card.verdict]?.[0]} />
          {card.before.pct != null && card.after.pct != null && <span className="tabular-nums">{card.before.pct}% → {card.after.pct}% as written ({card.scope})</span>}
        </div>
      )}
      {preview && (
        <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-2.5 text-xs">
          {preview.rows.length === 0 && <div className="text-slate-500">The drafts this came from are gone, so there is nothing to replay.</div>}
          {preview.rows.map((r) => (
            <dl key={r.draftId} className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1">
              <dt className="text-slate-400">They said</dt><dd className="text-slate-600">{r.theySaid}</dd>
              <dt className="text-slate-400">Without it</dt><dd className="text-slate-600">{r.before}</dd>
              <dt className="font-semibold text-slate-500">With it</dt><dd className="text-slate-900">{r.after}</dd>
              {r.youSent && <><dt className="text-slate-400">You sent</dt><dd className="text-slate-600">{r.youSent}</dd></>}
            </dl>
          ))}
          <div className="text-slate-400">{preview.note}</div>
        </div>
      )}
      {p.issue?.url && <a href={p.issue.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-blue-700 hover:underline">Issue #{p.issue.number}</a>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {p.status === "open" && p.kind !== "code_gap" && (
          <button type="button" className={BTN_PRIMARY} disabled={Boolean(busy)} onClick={() => act("apply")}>{busy === "apply" ? "Applying…" : "Apply"}</button>
        )}
        {p.status === "open" && p.kind === "code_gap" && (
          <button type="button" className={BTN_PRIMARY} disabled={Boolean(busy) || !canFile} title={canFile ? "" : "Add the GitHub repo and an issues-only token in Settings first"} onClick={() => act("file")}>
            {busy === "file" ? "Filing…" : "File for a fix"}
          </button>
        )}
        {p.status === "open" && p.kind !== "code_gap" && p.evidence?.length > 0 && (
          <button type="button" className={BTN} disabled={Boolean(busy)} onClick={tryIt} title="Drafts the same messages with and without this. Saves and sends nothing.">{busy === "preview" ? "Drafting…" : "Try it first"}</button>
        )}
        {p.status === "open" && <button type="button" className={BTN} disabled={Boolean(busy)} onClick={() => act("reject")}>{busy === "reject" ? "…" : "Reject"}</button>}
        {p.status === "applied" && <button type="button" className={BTN} disabled={Boolean(busy)} onClick={() => act("revert")}>{busy === "revert" ? "Reverting…" : "Revert"}</button>}
        {p.status === "applied" && <span className="text-xs text-slate-400">applied {when(p.appliedAt)}</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </li>
  );
}

export default function CoachCard() {
  const [coach, setCoach] = useState(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const poll = useRef(null);
  const load = () => getCoach().then((c) => { setCoach(c); setError(""); return c; }).catch((e) => { setError(e.message); return null; });
  useEffect(() => { load(); return () => clearInterval(poll.current); }, []);

  const run = async () => {
    setRunning(true); setError("");
    try { await runCoach({ dryRun: false }); } catch (e) { setError(e.message); setRunning(false); return; }
    poll.current = setInterval(async () => {
      const c = await load();
      if (!c || !c.run) { clearInterval(poll.current); setRunning(false); }
    }, 3000);
  };

  return <CoachBody coach={coach} error={error} running={running} onRun={run} onDone={load} />;
}

// The card itself, given its data — what the tests render.
export function CoachBody({ coach, error = "", running = false, onRun, onDone: load }) {
  const [showApplied, setShowApplied] = useState(false);
  // Off and never run: it has nothing to say, so it takes no room on Today.
  if (!coach) return error ? <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-red-700">Couldn't load what the coach learned — {error}</section> : null;
  if (!coach.enabled && !coach.last && !coach.open.length && !coach.applied.length) return null;

  const last = coach.last;
  const c = last?.counts;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-sm font-bold">Learned last night</h2>
        <span className="flex items-center gap-2 text-[11px] text-slate-400">
          {last ? `${last.trigger === "daily" ? "ran" : "run by hand"} ${when(last.finishedAt)}` : coach.enabled ? `runs at ${coach.hour}:00 Pacific` : "switched off"}
          <button type="button" disabled={running} onClick={onRun}
            className="rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
            {running ? "running…" : "Run now"}
          </button>
        </span>
      </div>

      {error && <div className="mb-2 text-sm text-red-700">{error}</div>}
      {last?.status === "error" && <div className="mb-2 text-sm text-red-700">The last run failed: {last.error}</div>}
      {last && last.status !== "error" && (
        <div className="mb-2 text-sm text-slate-600">
          {last.skipped
            ? <>Nothing to learn from — nobody edited, dismissed or broke anything.</>
            : <>Read <b>{c?.edits ?? 0}</b> edits · <b>{c?.dismissals ?? 0}</b> dismissals · <b>{c?.yours ?? 0}</b> you answered yourself · <b>{c?.errors ?? 0}</b> errors. {last.summary}</>}
          {last.dropped?.length ? <span className="text-slate-400"> · {last.dropped.length} idea{last.dropped.length === 1 ? "" : "s"} thrown out ({[...new Set(last.dropped.map((d) => d.reason))].slice(0, 2).join("; ")})</span> : null}
        </div>
      )}

      {coach.open.length
        ? <ul className="divide-y divide-slate-100">{coach.open.map((p) => <Row key={p.id} p={p} canFile={coach.canFile} onDone={load} />)}</ul>
        : <div className="text-sm text-slate-400">Nothing waiting on you.</div>}

      {coach.applied.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <button type="button" onClick={() => setShowApplied((v) => !v)} aria-expanded={showApplied} className="text-xs font-medium text-blue-700 hover:underline">
            {showApplied ? "Hide" : "Show"} what you've applied ({coach.applied.length})
          </button>
          {showApplied && <ul className="divide-y divide-slate-100">{coach.applied.map((p) => <Row key={p.id} p={p} canFile={coach.canFile} onDone={load} />)}</ul>}
        </div>
      )}
    </section>
  );
}
