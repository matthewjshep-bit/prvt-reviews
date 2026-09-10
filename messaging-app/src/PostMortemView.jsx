// PostMortemView.jsx — why a deal we had under contract died, on one page.
//
// The numbers half is arithmetic the broker does the same way on every deal
// (shared/post-mortem.js); the words half is the model's reading of every
// thread, or a person's. Both are shown with their sources, and nothing on
// this page changes a setting — the Lessons view on the dashboard is where a
// recommendation becomes a click.

import React, { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, X, ClipboardCheck } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { FELL_THROUGH_LABEL } from "@shared/post-mortem.js";
import { PASS_REASON_LABEL } from "@shared/conversation-ai.js";
import { buildPostMortem, getPostMortem } from "./api.js";
import { BTN, BTN_PRIMARY, ErrorBar, KpiRow } from "./ui.jsx";

const POLL_MS = 3000;
const pctText = (n) => (n == null ? "—" : `${Math.round(n * 10) / 10}%`);
const dayText = (n) => (n == null ? "—" : `${n}d`);
const when = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }) : "";
};
const H = "text-[11px] font-bold uppercase tracking-wider text-slate-500";

function Section({ title, children, right }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <h3 className="text-sm font-bold">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Quote({ who, name, text, at, code, fromCall }) {
  return (
    <li className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500">
        <span className="font-semibold text-slate-700">{name || who}</span>
        {code && <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">{PASS_REASON_LABEL[code] || FELL_THROUGH_LABEL[code] || code}</span>}
        {at && <span>{when(at)}</span>}
        {fromCall && <span>(call)</span>}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap text-slate-800">“{text}”</div>
    </li>
  );
}

/**
 * The post-mortem body, given the stored object. Exported so a test can
 * render it without the modal chrome.
 */
export function PostMortemBody({ pm }) {
  const sc = pm.scorecard;
  const a = pm.analysis;
  const ceiling = sc.ceiling;
  const over = sc.overCeiling;
  return (
    <div className="space-y-4">
      <KpiRow cols="sm:grid-cols-3 lg:grid-cols-6" items={[
        { label: "Buyers were asked", value: fmtMoney(sc.buyerPrice), hint: `Contract ${fmtMoney(sc.contractPrice)} + fee ${fmtMoney(sc.assignmentFee)}` },
        { label: `Buyer ceiling (${ceiling.pct}% rule)`, value: ceiling.computable ? fmtMoney(ceiling.noFee) : "—", hint: `${ceiling.pct}% × ARV ${fmtMoney(sc.arv)} − repairs ${fmtMoney(sc.repairs)}` },
        { label: over ? "Over the line by" : "Under the line by", value: sc.gap == null ? "—" : fmtMoney(Math.abs(sc.gap)), hint: `${pctText(sc.gapPctOfArv)} of ARV` },
        { label: "Buyer price / ARV", value: pctText(sc.buyerPctOfArv), hint: `All-in with repairs: ${pctText(sc.allInPctOfArv)}` },
        { label: "Under contract", value: dayText(sc.days.underContract), hint: `First pass after ${dayText(sc.days.toFirstPass)}` },
        { label: "Buyers passed", value: `${sc.buyers.passed} of ${sc.buyers.contacted}`, hint: `${sc.buyers.replied} replied, ${sc.buyers.silent} silent (${sc.buyers.source})` },
      ]} />
      {over && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Buyers were asked <b>{fmtMoney(sc.gap)}</b> more than a flipper's {ceiling.pct}% rule allows on a {fmtMoney(sc.arv)} ARV with {fmtMoney(sc.repairs)} of repairs.
          The most the contract could have been at our {fmtMoney(sc.assignmentFee)} fee was <b>{fmtMoney(ceiling.withFee)}</b>.
          {sc.buyers.askedFor?.n > 0 && <> Buyers who named a number said <b>{fmtMoney(sc.buyers.askedFor.min)}</b>{sc.buyers.askedFor.n > 1 ? ` to ${fmtMoney(sc.buyers.askedFor.max)}` : ""}.</>}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Why it died">
          <div className="mb-2 text-sm">
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-white">{pm.reasons.label || "Unclassified"}</span>
            {pm.reasons.text && <span className="ml-2 text-slate-600">“{pm.reasons.text}”</span>}
          </div>
          {pm.reasons.coded.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
              {pm.reasons.coded.map((r) => (
                <span key={r.code} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">{r.label} <b>{r.count}</b></span>
              ))}
            </div>
          )}
          {a?.rootCauses?.length > 0 && (
            <ul className="space-y-2">
              {a.rootCauses.map((rc, i) => (
                <li key={i} className="text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold">{rc.label}</span>
                    <span className="text-xs text-slate-400">{Math.round(rc.weight * 100)}%</span>
                  </div>
                  {rc.summary && <div className="text-slate-700">{rc.summary}</div>}
                  {rc.evidence.length > 0 && (
                    <ul className="mt-1 space-y-1 border-l-2 border-slate-200 pl-2 text-xs text-slate-600">
                      {rc.evidence.map((e, j) => <li key={j}><span className="font-semibold">{e.who}:</span> “{e.quote}”{e.at ? ` — ${when(e.at)}` : ""}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!a && <p className="text-xs text-slate-400">No reading yet — the numbers and the quotes are here; press Rebuild with an AI key in Settings for the story.</p>}
        </Section>

        <Section title="What the buyers said">
          {pm.reasons.quotes.length ? (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto">
              {pm.reasons.quotes.map((q, i) => <Quote key={i} who="buyer" name={q.name} text={q.text} at={q.at} code={q.code} fromCall={q.fromCall} />)}
            </ul>
          ) : <p className="text-xs text-slate-400">No buyer said why, in writing or on a call we have.</p>}
          {a?.buyerSide?.narrative && <p className="mt-2 text-sm text-slate-700">{a.buyerSide.narrative}</p>}
          {a?.buyerSide?.whatTheyNeeded && <p className="mt-1 text-sm"><span className={H}>What they needed</span><br />{a.buyerSide.whatTheyNeeded}</p>}
        </Section>

        <Section title="The negotiation">
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span><span className={H}>First offer</span><br /><b>{fmtMoney(pm.negotiation.firstOffer)}</b></span>
            {pm.negotiation.counter && <span><span className={H}>Their counter</span><br /><b>{fmtMoney(pm.negotiation.counter)}</b></span>}
            <span><span className={H}>Contract</span><br /><b>{fmtMoney(pm.negotiation.contractPrice)}</b> <span className="text-xs text-slate-500">({pm.negotiation.climb >= 0 ? "+" : "−"}{fmtMoney(Math.abs(pm.negotiation.climb))}, {pm.negotiation.revisions.length} revision{pm.negotiation.revisions.length === 1 ? "" : "s"})</span></span>
            <span><span className={H}>Ceiling for the contract</span><br /><b>{ceiling.computable ? fmtMoney(ceiling.withFee) : "—"}</b></span>
          </div>
          {pm.negotiation.sellerNamedPrice && (
            <div className="mb-2 rounded-lg bg-rose-50 px-3 py-1.5 text-xs text-rose-800">The contract price was the seller's own number first ({when(pm.negotiation.sellerNamedAt)}), and we wrote it.</div>
          )}
          {a?.agentSide?.narrative && <p className="mb-2 text-sm text-slate-700">{a.agentSide.narrative}</p>}
          {a?.agentSide?.concessions?.length > 0 && (
            <ul className="mb-2 space-y-1 text-xs text-slate-600">
              {a.agentSide.concessions.map((c, i) => <li key={i}>{when(c.at)}: {c.from ? `${fmtMoney(c.from)} → ` : ""}{c.to ? fmtMoney(c.to) : ""} — {c.why}</li>)}
            </ul>
          )}
          {a?.agentSide?.backOutResponse && <p className="mb-2 text-xs text-slate-600"><span className={H}>When we backed out</span><br />{a.agentSide.backOutResponse}</p>}
          {pm.negotiation.exchange.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-slate-500">Every line with a number or a no ({pm.negotiation.exchange.length})</summary>
              <ul className="mt-1 max-h-64 space-y-1 overflow-y-auto text-xs">
                {pm.negotiation.exchange.map((x, i) => (
                  <li key={i} className={x.who === "us" ? "text-slate-500" : "text-slate-800"}>
                    <span className="font-mono">{String(x.at).slice(0, 10)}</span> <b>{x.who === "us" ? "us" : "agent"}</b> {x.channel === "call" ? "(call) " : ""}{x.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Section>

        <Section title="What to do differently">
          {a?.whatWouldHaveSold?.price && (
            <p className="mb-2 text-sm"><span className={H}>What would have sold</span><br /><b>{fmtMoney(a.whatWouldHaveSold.price)}</b> <span className="text-slate-600">— {a.whatWouldHaveSold.basis}</span></p>
          )}
          {a?.lessons?.length > 0 && (
            <ul className="mb-2 list-disc space-y-1 pl-5 text-sm">{a.lessons.map((l, i) => <li key={i}>{l}</li>)}</ul>
          )}
          {a?.offerProcessChanges?.length > 0 && (
            <>
              <div className={H}>Offer process</div>
              <ul className="list-disc space-y-1 pl-5 text-sm">{a.offerProcessChanges.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </>
          )}
          {!a && <p className="text-xs text-slate-400">The lessons across every deal live on the dashboard.</p>}
        </Section>
      </div>

      <div className="text-[11px] text-slate-400">
        Written {when(pm.generatedAt)}{a ? ` · reading by ${a.by}` : " · numbers only"} · {pm.sources.buyerThreads} buyer thread{pm.sources.buyerThreads === 1 ? "" : "s"}, agent thread {Math.round(pm.sources.agentThreadChars / 1000)}k chars
        {pm.warnings?.length ? ` · ${pm.warnings.join("; ")}` : ""}
      </div>
    </div>
  );
}

export default function PostMortemModal({ offer, onClose, onUpdated }) {
  const [pm, setPm] = useState(offer.deal?.postMortem || null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const timer = useRef(null);

  async function refresh() {
    try {
      const r = await getPostMortem(offer.id);
      setPm(r.postMortem || null);
      setJob(r.job);
      if (r.postMortem && r.postMortem.generatedAt !== offer.deal?.postMortem?.generatedAt) onUpdated?.({ ...offer, deal: { ...offer.deal, postMortem: r.postMortem } });
      if (r.job?.status === "running") timer.current = setTimeout(refresh, POLL_MS);
      else if (r.job?.status === "error") setError(r.job.error || "the post-mortem failed");
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { refresh(); return () => clearTimeout(timer.current); }, [offer.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function build(refreshThreads) {
    setError("");
    try {
      const r = await buildPostMortem(offer.id, { refresh: refreshThreads });
      setJob(r.job);
      timer.current = setTimeout(refresh, POLL_MS);
    } catch (e) { setError(e.message); }
  }
  const running = job?.status === "running";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4" onClick={onClose}>
      <div className="my-4 w-full max-w-5xl rounded-2xl bg-slate-50 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-lg font-black"><ClipboardCheck size={18} /> Post-mortem</div>
            <div className="text-sm text-slate-600">{offer.address}</div>
          </div>
          <div className="flex items-center gap-2">
            {running && <span className="flex items-center gap-1.5 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" /> {job.phase === "feedback" ? "reading buyer threads" : job.phase === "agent_thread" ? "reading the agent thread" : job.phase === "analysis" ? "reading it all" : job.phase || "working"}…</span>}
            <button type="button" className={pm ? BTN : BTN_PRIMARY} disabled={running} onClick={() => build(false)} title="Read the threads and write the post-mortem">
              <RefreshCw size={13} /> {pm ? "Rebuild" : "Write the post-mortem"}
            </button>
            {pm && <button type="button" className={BTN} disabled={running} onClick={() => build(true)} title="Re-read every buyer thread first (a minute or two)">Re-read threads</button>}
            <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
          </div>
        </div>
        {error && <div className="mb-3"><ErrorBar>{error}</ErrorBar></div>}
        {pm ? <PostMortemBody pm={pm} /> : (
          <p className="text-sm text-slate-500">Nothing written yet. The post-mortem reads every buyer thread and the listing agent's thread, scores the deal against the buyer ceiling, and — with an AI key in Settings — says in words why it died.</p>
        )}
      </div>
    </div>
  );
}
