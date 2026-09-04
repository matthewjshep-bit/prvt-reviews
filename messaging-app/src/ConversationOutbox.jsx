// ConversationOutbox.jsx — the rows of the Conversation AI's outbox: what it
// is drafting right now, what it couldn't draft, and every reply waiting on a
// person or counting down to sending itself.
//
// One row component for both places it shows — the strip at the top of
// History and the "Waiting on you" card on the Conversation AI tab — so a
// draft looks and behaves the same wherever you meet it.

import React, { useEffect, useState } from "react";
import { AlertTriangle, Check, Clock, Loader2, Pause, Play, Send } from "lucide-react";
import { INTENT_LABEL, PARTY_LABEL } from "@shared/conversation-ai.js";
import { applyDraftAction, dismissReplyDraft, holdReplyDraft, sendReplyDraft } from "./api.js";
import { BTN, BTN_PRIMARY, Pill } from "./ui.jsx";

export const LIVE = new Set(["queued", "running"]);

const INTENT_CLS = {
  realm_check: "bg-violet-100 text-violet-800", realm_yes: "bg-emerald-100 text-emerald-800",
  counter: "bg-violet-100 text-violet-800", acceptance: "bg-emerald-100 text-emerald-800",
  rejection: "bg-rose-100 text-rose-700", passing: "bg-rose-100 text-rose-700",
  wants_call: "bg-amber-100 text-amber-800", scheduling: "bg-amber-100 text-amber-800",
  wants_walkthrough: "bg-amber-100 text-amber-800", proof_of_funds: "bg-amber-100 text-amber-800",
  price_pushback: "bg-violet-100 text-violet-800", wants_to_buy: "bg-emerald-100 text-emerald-800",
  new_property: "bg-sky-100 text-sky-800", interested: "bg-sky-100 text-sky-800",
  looking_for_deals: "bg-sky-100 text-sky-800", buybox_update: "bg-sky-100 text-sky-800",
};
const PARTY_CLS = { agent: "bg-slate-200 text-slate-700", investor: "bg-sky-100 text-sky-800", unknown: "bg-amber-100 text-amber-800" };

const PHASE = {
  queued: "Queued", waiting: "Waiting for follow-up texts", reading: "Reading the thread", drafting: "Drafting",
  saving: "Saving", filing: "Filing what it learned", acting: "Running actions", scheduling: "Scheduling",
};

export const intentLabel = (party, intent) =>
  INTENT_LABEL[party]?.[intent] || INTENT_LABEL.agent[intent] || String(intent || "").replace(/_/g, " ");

export const ago = (iso) => {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

const countdown = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

export function PartyPill({ party, small = true }) {
  const p = party || "agent";
  return <Pill label={PARTY_LABEL[p] || p} cls={PARTY_CLS[p] || PARTY_CLS.agent} small={small} />;
}

export function IntentPill({ party, intent, small = true }) {
  return <Pill label={intentLabel(party, intent)} cls={INTENT_CLS[intent] || "bg-slate-100 text-slate-600"} small={small} />;
}

/**
 * OutboxList — the <li> rows. `jobs` and `drafts` come straight from the
 * outbox endpoint; `serverOffsetMs` is (browser clock − broker clock) at fetch
 * time so the countdown reads the broker's "now", not the laptop's.
 */
export function OutboxList({ jobs = [], drafts = [], sendsEnabled, serverOffsetMs = 0, onDone }) {
  const liveJobs = jobs.filter((j) => LIVE.has(j.status));
  const failed = jobs.filter((j) => (j.status === "error" || j.status === "held") && Date.now() - Date.parse(j.finishedAt || 0) < 3600_000);
  return (
    <ul className="divide-y divide-slate-200">
      {liveJobs.map((job) => (
        <li key={job.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
          <Loader2 size={14} className="shrink-0 animate-spin text-blue-600" />
          <span className="font-semibold text-slate-900">{job.contactName || "a contact"}</span>
          {job.party && <PartyPill party={job.party} />}
          <span className="text-xs text-slate-600">{PHASE[job.phase] || "Working"}</span>
          <span className="truncate text-xs text-slate-500">“{job.message}”</span>
        </li>
      ))}
      {failed.map((job) => (
        <li key={job.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
          <AlertTriangle size={14} className={`shrink-0 ${job.status === "held" ? "text-amber-600" : "text-red-600"}`} />
          <span className="font-semibold text-slate-900">{job.contactName || "a contact"}</span>
          <span className={`text-xs ${job.status === "held" ? "text-amber-800" : "text-red-700"}`}>
            {job.status === "held" ? job.heldReason || "held" : `${job.error || "drafting failed"} — answer by hand`}
          </span>
        </li>
      ))}
      {drafts.map((d) => (
        <DraftRow key={d.id} draft={d} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} onDone={onDone} />
      ))}
    </ul>
  );
}

export function DraftRow({ draft: d, sendsEnabled, serverOffsetMs = 0, onDone }) {
  const [text, setText] = useState(d.reply || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const [, tick] = useState(0);
  const scheduled = d.status === "scheduled" && d.sendAt;

  // The countdown re-renders once a second only while there is one.
  useEffect(() => {
    if (!scheduled) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [scheduled]);

  const run = async (label, fn) => {
    setBusy(label); setError("");
    try { await fn(); onDone?.(); }
    catch (e) { setError(e.message); }
    setBusy("");
  };
  const send = async () => {
    setBusy("send"); setError("");
    try {
      const r = await sendReplyDraft(d.id, text);
      if (r.dryRun) { setPreview(true); setBusy(""); return; }
      onDone?.();
    } catch (e) { setError(e.message); setBusy(""); }
  };

  const edited = text.trim() !== String(d.reply || "").trim();
  const chars = text.length;
  const remaining = scheduled ? Date.parse(d.sendAt) - (Date.now() - serverOffsetMs) : 0;
  const actions = d.actions || [];
  const pending = actions.filter((a) => a.status === "pending");
  const settled = actions.filter((a) => a.status !== "pending");

  return (
    <li className="px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {scheduled
          ? <Clock size={14} className="shrink-0 text-amber-600" />
          : d.autoSendable
          ? <Check size={14} className="shrink-0 text-emerald-600" />
          : <AlertTriangle size={14} className="shrink-0 text-amber-600" />}
        <span className="font-semibold text-slate-900">{d.contactName || "Unknown contact"}</span>
        <PartyPill party={d.party} />
        {d.propertyAddress && <span className="text-xs text-slate-500">{d.propertyAddress}</span>}
        <IntentPill party={d.party} intent={d.intent} />
        {d.channel === "email" && <Pill label="email" small />}
        <span className="ml-auto text-xs text-slate-500">{ago(d.createdAt)}</span>
      </div>

      {d.outbound?.kind === "realm_check" ? (
        <div className="mt-1 text-xs text-slate-600">
          <span className="text-slate-400">Numbers came back:</span> our offer on {d.outbound.address} is {d.outbound.amount ? `$${Number(d.outbound.amount).toLocaleString()}` : "set"} — this floats it before the formal offer goes.
        </div>
      ) : (
        <div className="mt-1 text-xs text-slate-600">
          <span className="text-slate-400">They said:</span> “{d.inbound}”
        </div>
      )}
      {d.summary && <div className="mt-0.5 text-xs text-slate-500">{d.summary}</div>}

      {scheduled ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          <Clock size={12} />
          {remaining > 0 ? <>Sending itself in <span className="tabular-nums font-semibold">{countdown(remaining)}</span></> : "Sending now…"}
          <button type="button" className={`${BTN} ml-auto`} disabled={Boolean(busy)}
            onClick={() => run("hold", () => holdReplyDraft(d.id))}>
            <Pause size={12} /> {busy === "hold" ? "Holding…" : "Hold"}
          </button>
        </div>
      ) : d.flags?.length > 0 ? (
        <div className="mt-0.5 text-xs text-amber-800">Needs you: {d.flags.join(" · ")}</div>
      ) : (
        <div className="mt-0.5 text-xs text-emerald-700">
          Would have been safe to send on its own.
          {d.autoSend && !d.autoSend.decided && d.autoSend.reason ? <span className="text-slate-500"> Didn’t, because {d.autoSend.reason}.</span> : null}
        </div>
      )}

      {d.profileUpdates?.learned?.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-500">
          <span className="text-slate-400">Filed to their profile:</span> {d.profileUpdates.learned.join(" · ")}
        </div>
      )}
      {d.humanActive && !scheduled && (
        <div className="mt-0.5 text-[11px] text-slate-500">You replied to them {d.humanActive.minutesAgo}m ago, so this waits for you.</div>
      )}
      {(settled.length > 0 || pending.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {settled.map((a) => (
            <span key={a.id} title={a.error || a.detail || ""}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                a.status === "failed" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
              {a.status === "failed" ? <AlertTriangle size={11} /> : <Check size={11} />}
              {a.status === "failed" ? `${a.type.replace(/_/g, " ")} failed` : a.detail || a.type.replace(/_/g, " ")}
            </span>
          ))}
          {pending.map((a) => (
            <button key={a.id} type="button" disabled={Boolean(busy)}
              onClick={() => run(a.id, () => applyDraftAction(d.id, a.id))}
              className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-40"
              title="Suggested by the AI — click to apply">
              <Play size={11} /> {busy === a.id ? "Applying…" : actionLabel(a)}
            </button>
          ))}
        </div>
      )}

      <textarea
        className="mt-2 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        rows={Math.min(6, Math.max(2, Math.ceil(text.length / 90)))}
        value={text}
        onChange={(e) => { setText(e.target.value); setPreview(false); }}
        placeholder="Nothing drafted — write the reply here"
        aria-label={`Reply to ${d.contactName || "contact"}`}
      />

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-slate-400">
          {chars} chars{d.channel !== "email" && chars > 160 ? ` · ${Math.ceil(chars / 153)} texts` : ""}{edited ? " · edited" : ""}
        </span>
        {error && <span className="text-xs text-red-700">{error}</span>}
        {preview && !error && (
          <span className="text-xs text-amber-700">
            Previewed only — {sendsEnabled ? "try again" : "set CARD_SENDS_ENABLED=true on the broker to send"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BTN} disabled={Boolean(busy)} onClick={() => run("dismiss", () => dismissReplyDraft(d.id))}>
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={Boolean(busy) || !text.trim()} onClick={send}>
            <Send size={13} /> {busy === "send" ? "Sending…" : scheduled ? "Send now" : "Send"}
          </button>
        </div>
      </div>
    </li>
  );
}

function actionLabel(a) {
  switch (a.type) {
    case "add_tags": return `Tag ${a.tags?.join(", ")}`;
    case "remove_tags": return `Untag ${a.tags?.join(", ")}`;
    case "set_field": return `Set ${a.key}`;
    case "add_to_workflow": return `Add to ${a.workflowName || "workflow"}`;
    case "link_deal_evaluating": return "Link to the deal";
    case "start_underwrite": return "Underwrite it";
    case "suggest_dataroom_invite": return "Text a dataroom link";
    default: return a.type;
  }
}
