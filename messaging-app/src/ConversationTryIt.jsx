// ConversationTryIt.jsx — run the bot without anyone getting a text.
//
// Pick a real contact (their real thread, offers or deals) or type a thread
// by hand, add the message they'd send, and see exactly what would happen:
// who the broker thinks they are, the context the model saw, the intent, the
// draft, why it would or wouldn't send itself, and the actions that would
// fire. Nothing is saved, sent, tagged or scheduled.

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Play } from "lucide-react";
import { searchContacts, testConversation } from "./api.js";
import { BTN, BTN_PRIMARY, ErrorBar, Pill } from "./ui.jsx";
import { IntentPill, PartyPill } from "./ConversationOutbox.jsx";
import { INPUT_CLS, Section } from "./ConversationPlaybooks.jsx";

function ContactPicker({ value, onPick }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    clearTimeout(timer.current);
    if (query.trim().length < 2) { setResults([]); return undefined; }
    timer.current = setTimeout(() => {
      setSearching(true);
      searchContacts(query.trim()).then(setResults).catch(() => setResults([])).finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query]);
  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm">
        <span className="font-medium">{value.name || "(no name)"}</span>
        <span className="text-xs text-slate-500">{[value.phone, value.email].filter(Boolean).join(" · ")}</span>
        <button type="button" className={`${BTN} ml-auto`} onClick={() => onPick(null)}>Change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input className={INPUT_CLS} value={query} placeholder="Search your GHL contacts…"
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {searching && <Loader2 size={14} className="absolute right-3 top-3 animate-spin text-slate-400" />}
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {results.map((c) => (
            <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(c); setQuery(""); setResults([]); setOpen(false); }}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50">
              <span><span className="font-medium">{c.name || "(no name)"}</span>
                <span className="ml-2 text-xs text-slate-500">{[c.phone, c.email].filter(Boolean).join(" · ")}</span></span>
              {c.tags?.length > 0 && <span className="text-[11px] text-slate-400">{c.tags.slice(0, 3).join(", ")}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// "THEM: …" / "US: …" lines; a line with no prefix is theirs.
const parseThread = (text) =>
  String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(us|them)\s*:\s*(.*)$/i.exec(l);
    return m ? { dir: m[1].toUpperCase(), text: m[2] } : { dir: "THEM", text: l };
  });

export default function ConversationTryIt({ sendsEnabled }) {
  const [mode, setMode] = useState("contact");
  const [contact, setContact] = useState(null);
  const [party, setParty] = useState("agent");
  const [thread, setThread] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [showContext, setShowContext] = useState(false);

  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try {
      const r = await testConversation(mode === "contact"
        ? { contactId: contact?.id, message }
        : { party, thread: parseThread(thread), message });
      setResult(r);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const canRun = message.trim() && (mode === "contact" ? Boolean(contact) : true);

  return (
    <Section title="Try it"
      intro="Run the whole pipeline on a real contact or a typed thread. Nothing is saved, sent, tagged or scheduled — this is where you tune the page.">
      <div className="mb-3 inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
        {[["contact", "A real contact"], ["typed", "A typed thread"]].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setMode(k)} aria-pressed={mode === k}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === k ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</button>
        ))}
      </div>
      {mode === "contact" ? (
        <ContactPicker value={contact} onPick={setContact} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">They are</span>
            <select className={INPUT_CLS} value={party} onChange={(e) => setParty(e.target.value)}>
              <option value="agent">A listing agent</option>
              <option value="investor">An investor</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">The thread so far</span>
            <textarea className={`${INPUT_CLS} resize-y`} rows={3} value={thread} onChange={(e) => setThread(e.target.value)}
              placeholder={"US: Sent you our offer on 12 Elm — $410k cash, 14-day close.\nTHEM: got it, will show the seller"} />
          </label>
        </div>
      )}
      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Their newest message</span>
        <div className="flex gap-2">
          <input className={INPUT_CLS} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder={mode === "contact" ? "still interested?" : "any chance you'd do 425k?"}
            onKeyDown={(e) => { if (e.key === "Enter" && canRun && !busy) run(); }} />
          <button type="button" className={BTN_PRIMARY} disabled={!canRun || busy} onClick={run}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Run
          </button>
        </div>
      </label>
      {error && <div className="mt-3"><ErrorBar>{error}</ErrorBar></div>}
      {result && (
        <div className="mt-4 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">They are</span>
            <PartyPill party={result.party} small={false} />
            <span className="text-xs text-slate-400">by {result.partySource === "try-it" ? "your pick" : result.partySource === "tags" ? `tags: ${[...(result.matchedTags?.agent || []), ...(result.matchedTags?.investor || [])].join(", ") || "none"}` : result.partySource}</span>
            {result.contactName && <span className="text-xs text-slate-500">· {result.contactName}</span>}
          </div>
          {result.held ? (
            <div className="text-amber-800">{result.reason}</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <IntentPill party={result.party} intent={result.draft.intent} small={false} />
                <Pill label={`${result.draft.confidence} confidence`} cls={result.draft.confidence === "high" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"} />
                {result.draft.propertyAddress && <span className="text-xs text-slate-500">{result.draft.propertyAddress}</span>}
              </div>
              {result.draft.summary && <div className="text-xs text-slate-500">{result.draft.summary}</div>}
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 whitespace-pre-wrap">
                {result.draft.reply || <span className="italic text-slate-400">(no reply — the model thought none was needed)</span>}
              </div>
              <div className={result.gate.ok ? "text-xs text-emerald-700" : "text-xs text-amber-800"}>
                {result.gate.ok ? "Every gate passed." : `Needs you: ${result.gate.flags.join(" · ")}`}
              </div>
              <div className="text-xs text-slate-600">
                {result.autoSend.would
                  ? <>Would send itself at <span className="font-medium">{new Date(result.autoSend.sendAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>.</>
                  : <>Would wait for you — {result.autoSend.reason}.</>}
                {!sendsEnabled && " (Sends are off on the broker.)"}
              </div>
              {(result.actions.auto.length > 0 || result.actions.suggested.length > 0) && (
                <div className="text-xs text-slate-600">
                  {result.actions.auto.length > 0 && <div>Would do automatically: {result.actions.auto.map(describe).join(", ")}</div>}
                  {result.actions.suggested.length > 0 && <div>Would suggest: {result.actions.suggested.map(describe).join(", ")}</div>}
                </div>
              )}
            </>
          )}
          <button type="button" className={BTN} onClick={() => setShowContext((s) => !s)}>
            {showContext ? <ChevronUp size={13} /> : <ChevronDown size={13} />} What the model saw
          </button>
          {showContext && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-[11px] leading-snug text-slate-700">
              {[result.instructions ? `STANDING INSTRUCTIONS:\n${result.instructions}` : "", result.context?.text || "(no records)", result.transcript ? `THREAD:\n${result.transcript}` : "THREAD: (none)"].filter(Boolean).join("\n\n")}
              {result.context?.forbiddenAmounts?.length ? `\n\nMUST NEVER SAY: ${result.context.forbiddenAmounts.join(", ")}` : ""}
            </pre>
          )}
          {result.warnings?.length > 0 && <div className="text-xs text-slate-400">{result.warnings.join(" · ")}</div>}
        </div>
      )}
    </Section>
  );
}

const describe = (a) => {
  switch (a.type) {
    case "add_tags": return `tag ${a.tags?.join(", ")}`;
    case "remove_tags": return `untag ${a.tags?.join(", ")}`;
    case "set_field": return `set ${a.key}`;
    case "add_to_workflow": return `add to ${a.workflowName || a.workflowId}`;
    case "link_deal_evaluating": return "link to the deal";
    case "start_underwrite": return "start an underwrite";
    case "suggest_dataroom_invite": return "text a dataroom link";
    default: return a.type;
  }
};
