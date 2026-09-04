// ConversationTryIt.jsx — a chat window for testing the Conversation AI.
//
// Text it the way a lead would and watch it answer, turn after turn. Pick a
// real contact and it answers with their real thread, records and buy box
// behind it — or pick a party and talk to it cold. Under each reply: what it
// heard, whether it would have sent that itself, and what it would have
// triggered. Nothing here is saved, sent, tagged or scheduled, and nothing
// reaches the contact. This is the same shape GHL's own "Test your agent"
// window has, because that is the shape people already know how to use.

import React, { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronUp, Loader2, MessageSquare, RotateCcw, Send, Shield } from "lucide-react";
import { PARTY_LABEL } from "@shared/conversation-ai.js";
import { searchContacts, testConversation } from "./api.js";
import { BTN } from "./ui.jsx";
import { IntentPill, PartyPill } from "./ConversationOutbox.jsx";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

const EXAMPLES = {
  agent: ["Hey, still interested in the house?", "Any chance you'd do 425k?", "Can you send proof of funds?", "Seller wants to know your timeline."],
  investor: ["What's the price on that one?", "Got anything in Tacoma right now?", "Is it still available?", "What's your fee on it?"],
};

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
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{value.name || "(no name)"}</span>
        <span className="text-xs text-slate-500">{[value.phone, value.email].filter(Boolean).join(" · ")}</span>
        <button type="button" className={`${BTN} ml-auto`} onClick={() => onPick(null)}>Change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input className={INPUT_CLS} value={query} placeholder="Search your GHL contacts — or leave blank to talk to it cold"
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

/**
 * <ConversationTryIt sendsEnabled compact />
 *
 * `compact` drops the section chrome so it can sit inside another card
 * (the Settings page); the tab shows it full size.
 */
export default function ConversationTryIt({ sendsEnabled = true, compact = false }) {
  const [contact, setContact] = useState(null);
  const [party, setParty] = useState("auto");       // auto = let the tags decide (needs a contact)
  const [turns, setTurns] = useState([]);           // [{ who: "lead"|"bot", text, meta? }]
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);           // index of the bot turn whose details are open
  const scroller = useRef(null);
  const input = useRef(null);

  const effectiveParty = contact ? (party === "auto" ? "" : party) : (party === "auto" ? "agent" : party);
  const lastBot = [...turns].reverse().find((t) => t.who === "bot");
  const knownParty = lastBot?.meta?.party || (effectiveParty || null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, busy]);

  const reset = () => { setTurns([]); setError(""); setOpen(null); input.current?.focus(); };

  const send = async (text) => {
    const msg = String(text || message).trim();
    if (!msg || busy) return;
    if (!contact && !effectiveParty) return;
    setError(""); setMessage("");
    const thread = turns.map((t) => ({ dir: t.who === "lead" ? "THEM" : "US", text: t.text }));
    setTurns((ts) => [...ts, { who: "lead", text: msg }]);
    setBusy(true);
    try {
      const r = await testConversation({ contactId: contact?.id, party: effectiveParty || undefined, thread, message: msg });
      const text = r.held ? "" : (r.draft?.reply || "");
      setTurns((ts) => [...ts, { who: "bot", text, meta: r }]);
    } catch (e) {
      setError(e.message);
      setTurns((ts) => ts.slice(0, -1));
      setMessage(msg);
    }
    setBusy(false);
  };

  const body = (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-gradient-to-r from-blue-600 to-violet-500 px-3 py-2 text-sm font-semibold text-white">
        <MessageSquare size={15} /> Test the Conversation AI
        <button type="button" onClick={reset} aria-label="Start over" title="Start over"
          className="ml-auto rounded-full p-1 text-white/80 transition-colors hover:bg-white/15 hover:text-white">
          <RotateCcw size={15} />
        </button>
      </div>

      <div className="space-y-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <ContactPicker value={contact} onPick={(c) => { setContact(c); reset(); }} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>Treat them as</span>
          <select className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs" value={party} onChange={(e) => { setParty(e.target.value); reset(); }}>
            {contact && <option value="auto">whatever their tags say</option>}
            {!contact && <option value="auto">a listing agent</option>}
            <option value="agent">a listing agent</option>
            <option value="investor">an investor</option>
          </select>
          {knownParty && lastBot && (
            <span className="inline-flex items-center gap-1">
              → <PartyPill party={knownParty} />
              {lastBot.meta?.partySource === "tags" && <span className="text-slate-400">by their tags</span>}
            </span>
          )}
          {contact && <span className="ml-auto text-slate-400">Their real thread and records are behind every reply.</span>}
        </div>
      </div>

      <div ref={scroller} className="max-h-[28rem] min-h-[16rem] space-y-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 && (
          <div className="flex h-full min-h-[14rem] flex-col items-center justify-center text-center">
            <span className="mb-2 inline-flex h-11 w-11 items-center justify-center rounded-full bg-blue-50 text-blue-600"><Bot size={22} /></span>
            <div className="text-base font-semibold text-slate-900">Try it</div>
            <div className="text-sm text-slate-500">Send a message the way {contact ? (contact.name?.split(" ")[0] || "they") : "a lead"} would.<br />Nothing here reaches your contacts.</div>
          </div>
        )}
        {turns.map((t, i) => t.who === "lead" ? (
          <div key={i} className="flex justify-end">
            <div className="max-w-[80%] rounded-2xl rounded-br-md bg-blue-600 px-3.5 py-2 text-sm text-white">{t.text}</div>
          </div>
        ) : (
          <BotTurn key={i} turn={t} open={open === i} onToggle={() => setOpen(open === i ? null : i)} sendsEnabled={sendsEnabled} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={13} className="animate-spin" /> thinking…</div>
        )}
      </div>

      <div className="border-t border-slate-200 px-3 pb-3 pt-2">
        {error && <div className="mb-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">{error}</div>}
        {turns.length === 0 && (
          <div className="mb-2">
            <div className="mb-1 text-xs text-slate-400">Select an example to try it out</div>
            <div className="flex flex-wrap gap-1.5">
              {(EXAMPLES[knownParty === "investor" ? "investor" : "agent"]).map((ex) => (
                <button key={ex} type="button" onClick={() => send(ex)} disabled={busy || (!contact && !effectiveParty)}
                  className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-40">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <input ref={input} className={INPUT_CLS} value={message} placeholder="Send a message as the lead…"
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } }} />
          <button type="button" onClick={() => send()} disabled={busy || !message.trim()} aria-label="Send"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition-colors hover:bg-slate-200 disabled:opacity-40">
            <Send size={16} />
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-center gap-1 text-[11px] text-slate-400">
          <Shield size={11} /> Test messages are never sent to your contacts
        </div>
      </div>
    </div>
  );

  if (compact) return body;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-1 text-sm font-bold">Try it</h2>
      <p className="mb-3 text-xs text-slate-500">
        Chat with the bot as a lead would. On a real contact it answers with their real thread, offers, deals and buy box
        behind it. Nothing is saved, sent, tagged or scheduled — this is where the page gets tuned.
      </p>
      {body}
    </section>
  );
}

function BotTurn({ turn: t, open, onToggle, sendsEnabled }) {
  const m = t.meta || {};
  const d = m.draft || null;
  return (
    <div className="flex items-start gap-2">
      <span className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600"><Bot size={13} /></span>
      <div className="max-w-[85%]">
        <div className="rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2 text-sm text-slate-900 whitespace-pre-wrap">
          {m.held
            ? <span className="italic text-amber-800">{m.reason}</span>
            : t.text || <span className="italic text-slate-400">(no reply — the model thought none was needed)</span>}
        </div>
        {d && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
            <IntentPill party={m.party} intent={d.intent} />
            <span>{d.confidence} confidence</span>
            <span className={m.gate?.ok ? "text-emerald-700" : "text-amber-800"}>
              {m.gate?.ok
                ? (m.autoSend?.would ? "· would send itself" : `· safe, but would wait: ${m.autoSend?.reason}`)
                : `· needs you: ${m.gate?.flags?.[0]}${m.gate?.flags?.length > 1 ? ` +${m.gate.flags.length - 1}` : ""}`}
            </span>
            {(m.actions?.auto?.length > 0 || m.actions?.suggested?.length > 0) && (
              <span className="text-violet-700">
                · {m.actions.auto.length > 0 ? `would ${m.actions.auto.map(describe).join(", ")}` : ""}
                {m.actions.auto.length > 0 && m.actions.suggested.length > 0 ? "; " : ""}
                {m.actions.suggested.length > 0 ? `would suggest ${m.actions.suggested.map(describe).join(", ")}` : ""}
              </span>
            )}
            <button type="button" onClick={onToggle} className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-700">
              {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />} details
            </button>
          </div>
        )}
        {open && (
          <div className="mt-1 space-y-1 rounded-lg border border-slate-200 bg-white p-2 text-[11px] text-slate-600">
            {d?.summary && <div><span className="text-slate-400">Summary:</span> {d.summary}</div>}
            {m.gate?.flags?.length > 0 && <div><span className="text-slate-400">Flags:</span> {m.gate.flags.join(" · ")}</div>}
            {m.autoSend && (
              <div><span className="text-slate-400">Auto-send:</span> {m.autoSend.would ? `yes, at ${new Date(m.autoSend.sendAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : `no — ${m.autoSend.reason}`}{!sendsEnabled ? " (sends are off on the broker)" : ""}</div>
            )}
            <details>
              <summary className="cursor-pointer text-slate-400">What the model saw</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap leading-snug">
                {[m.instructions ? `STANDING INSTRUCTIONS:\n${m.instructions}` : "", m.context?.text || "(no records)", m.transcript ? `THREAD:\n${m.transcript}` : "THREAD: (none)"].filter(Boolean).join("\n\n")}
                {m.context?.forbiddenAmounts?.length ? `\n\nMUST NEVER SAY: ${m.context.forbiddenAmounts.join(", ")}` : ""}
              </pre>
            </details>
            {m.warnings?.length > 0 && <div className="text-slate-400">{m.warnings.join(" · ")}</div>}
          </div>
        )}
      </div>
    </div>
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

export { PARTY_LABEL };
