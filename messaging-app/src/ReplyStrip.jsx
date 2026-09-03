// ReplyStrip.jsx — replies the robot has written and is waiting for you to send.
//
// A GHL workflow hands an inbound agent text to the broker, which reads the
// thread and the offer book and drafts what we'd say. Nothing goes out by
// itself: each draft sits here until a person sends it (edited or not) or
// dismisses it. Same shape and place as the auto-underwrite strip — the top of
// History, where you'd come to see what the agent was texting about anyway —
// and like it, the strip disappears when there is nothing waiting.
//
// Each row shows the gate result beside the draft ("would have sent itself" vs
// the reasons it wouldn't), so over a few weeks you can see how often the
// agent would have been right before deciding whether to let it.

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, MessageSquare, Send } from "lucide-react";
import { dismissReplyDraft, getReplyDrafts, sendReplyDraft } from "./api.js";
import { BTN, BTN_PRIMARY, Pill } from "./ui.jsx";

const POLL_MS = 5000;
const LIVE = new Set(["queued", "running"]);

const INTENT_LABEL = {
  question: "question", counter: "counter", acceptance: "wants to move forward", rejection: "passed",
  wants_call: "wants a call", scheduling: "scheduling", proof_of_funds: "proof of funds",
  new_property: "new property", status_check: "checking in", small_talk: "small talk", other: "other",
};
const INTENT_CLS = {
  counter: "bg-violet-100 text-violet-800", acceptance: "bg-emerald-100 text-emerald-800",
  rejection: "bg-rose-100 text-rose-700", wants_call: "bg-amber-100 text-amber-800",
  scheduling: "bg-amber-100 text-amber-800", proof_of_funds: "bg-amber-100 text-amber-800",
  new_property: "bg-sky-100 text-sky-800",
};

const PHASE = { queued: "Queued", reading: "Reading the thread", drafting: "Drafting", saving: "Saving" };

const ago = (iso) => {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

export default function ReplyStrip() {
  const [drafts, setDrafts] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [sendsEnabled, setSendsEnabled] = useState(true);
  const timer = useRef(null);
  const [, bump] = useState(0);

  const refresh = async () => {
    const r = await getReplyDrafts();
    setDrafts(r.drafts || []);
    setJobs((r.jobs || []).filter((j) => LIVE.has(j.status) || j.status === "error"));
    setSendsEnabled(Boolean(r.sendsEnabled));
    return r;
  };

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await refresh();
        if (!alive) return;
        const live = (r.jobs || []).some((j) => LIVE.has(j.status));
        timer.current = setTimeout(tick, live ? POLL_MS : POLL_MS * 12);
      } catch {
        if (alive) timer.current = setTimeout(tick, POLL_MS * 12);
      }
    }
    tick();
    return () => { alive = false; clearTimeout(timer.current); };
  }, []);

  const liveJobs = jobs.filter((j) => LIVE.has(j.status));
  const failed = jobs.filter((j) => j.status === "error" && Date.now() - Date.parse(j.finishedAt || 0) < 3600_000);
  if (!drafts.length && !liveJobs.length && !failed.length) return null;

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
        <MessageSquare size={13} /> Replies to send
        {!sendsEnabled && (
          <span className="ml-auto normal-case font-normal tracking-normal text-amber-700">
            Sends are off on the broker (CARD_SENDS_ENABLED) — Send will preview only
          </span>
        )}
      </div>
      <ul className="divide-y divide-slate-200">
        {liveJobs.map((job) => (
          <li key={job.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
            <Loader2 size={14} className="shrink-0 animate-spin text-blue-600" />
            <span className="font-semibold text-slate-900">{job.contactName || "an agent"}</span>
            <span className="text-xs text-slate-600">{PHASE[job.phase] || "Working"}</span>
            <span className="truncate text-xs text-slate-500">“{job.message}”</span>
          </li>
        ))}
        {failed.map((job) => (
          <li key={job.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
            <AlertTriangle size={14} className="shrink-0 text-red-600" />
            <span className="font-semibold text-slate-900">{job.contactName || "an agent"}</span>
            <span className="text-xs text-red-700">{job.error || "drafting failed"} — answer by hand</span>
          </li>
        ))}
        {drafts.map((d) => (
          <DraftRow key={d.id} draft={d} sendsEnabled={sendsEnabled}
            onDone={() => { refresh().catch(() => {}); bump((n) => n + 1); }} />
        ))}
      </ul>
    </div>
  );
}

function DraftRow({ draft: d, sendsEnabled, onDone }) {
  const [text, setText] = useState(d.reply || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);

  const send = async () => {
    setBusy("send"); setError("");
    try {
      const r = await sendReplyDraft(d.id, text);
      if (r.dryRun) { setPreview(true); setBusy(""); return; }
      onDone();
    } catch (e) { setError(e.message); setBusy(""); }
  };
  const dismiss = async () => {
    setBusy("dismiss"); setError("");
    try { await dismissReplyDraft(d.id); onDone(); }
    catch (e) { setError(e.message); setBusy(""); }
  };

  const edited = text.trim() !== String(d.reply || "").trim();
  const chars = text.length;

  return (
    <li className="px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {d.autoSendable
          ? <Check size={14} className="shrink-0 text-emerald-600" />
          : <AlertTriangle size={14} className="shrink-0 text-amber-600" />}
        <span className="font-semibold text-slate-900">{d.contactName || "Unknown agent"}</span>
        {d.propertyAddress && <span className="text-xs text-slate-500">{d.propertyAddress}</span>}
        <Pill label={INTENT_LABEL[d.intent] || d.intent} cls={INTENT_CLS[d.intent] || "bg-slate-100 text-slate-600"} small />
        {d.channel === "email" && <Pill label="email" small />}
        <span className="ml-auto text-xs text-slate-500">{ago(d.createdAt)}</span>
      </div>

      <div className="mt-1 text-xs text-slate-600">
        <span className="text-slate-400">They said:</span> “{d.inbound}”
      </div>
      {d.summary && <div className="mt-0.5 text-xs text-slate-500">{d.summary}</div>}
      {d.flags?.length > 0 ? (
        <div className="mt-0.5 text-xs text-amber-800">Needs you: {d.flags.join(" · ")}</div>
      ) : (
        <div className="mt-0.5 text-xs text-emerald-700">Would have been safe to send on its own.</div>
      )}

      <textarea
        className="mt-2 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        rows={Math.min(6, Math.max(2, Math.ceil(text.length / 90)))}
        value={text}
        onChange={(e) => { setText(e.target.value); setPreview(false); }}
        placeholder="Nothing drafted — write the reply here"
        aria-label={`Reply to ${d.contactName || "agent"}`}
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
          <button type="button" className={BTN} disabled={Boolean(busy)} onClick={dismiss}>
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={Boolean(busy) || !text.trim()} onClick={send}>
            <Send size={13} /> {busy === "send" ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </li>
  );
}
