// ActionQueue.jsx — the things waiting on a person, grouped, with the button
// that does each one right there.
//
// Drafts render through the same DraftRow the outbox uses, so send / edit /
// dismiss / hold / apply come for free and behave identically. Everything
// else is a compact row: who, where, what, and the ops the endpoint named.

import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ACTION_GROUPS, ACTION_KINDS } from "@shared/pipeline.js";
import { AUDIT_ACTION_KINDS } from "@shared/conversation-audit.js";
import { PROMISE_DISMISS_REASONS, PROMISE_DISMISS_LABEL, answerNamesMoney } from "@shared/promise-resolver.js";
import { BTN, BTN_DANGER, BTN_PRIMARY, Pill } from "./ui.jsx";
import { DraftRow } from "./ConversationOutbox.jsx";
import ContactLink, { useOpenContact } from "./ContactLink.jsx";
import { answerPartnerQuestion, forgetStandingAnswer, ghlContactUrl } from "./api.js";
import { CONFIRM, describeResult, linkFor, runOp } from "./pipeline-ops.js";

const SEV = {
  now: { dot: "bg-rose-500", label: "now", cls: "bg-rose-100 text-rose-700" },
  soon: { dot: "bg-amber-400", label: "soon", cls: "bg-amber-100 text-amber-800" },
  fyi: { dot: "bg-slate-300", label: "fyi", cls: "bg-slate-100 text-slate-600" },
};
const DRAFT_KINDS = new Set(["draft_waiting", "draft_scheduled"]);
// "1:05 PM" today, "Thu 9:00 AM" otherwise.
const whenLabel = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
};
// What each group is, said once under its heading.
const GROUP_HINT = {
  yours: "Decisions only you make.",
  machine: "Already moving. Nothing to do unless you want to stop one.",
  stuck: "The machine tried and couldn't. Usually a phone call or a fix.",
};

function OpButton({ op, item, onDone }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const href = linkFor(op.key, item);
  if (href) {
    return <a href={href} target="_blank" rel="noreferrer" className={op.intent === "primary" ? BTN_PRIMARY : BTN}>{op.label}</a>;
  }
  const cls = op.intent === "danger" ? BTN_DANGER : op.intent === "primary" ? BTN_PRIMARY : BTN;
  async function go() {
    if (CONFIRM[op.key] && !window.confirm(CONFIRM[op.key](item))) return;
    setBusy(true); setNote("");
    try {
      const r = await runOp(op.key, item);
      setNote(describeResult(op.key, r));
      onDone?.();
    } catch (e) {
      setNote(e.message || "That didn't work.");
    } finally { setBusy(false); }
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" className={cls} disabled={busy} onClick={go}>{busy ? "…" : op.label}</button>
      {note && <span className="text-[11px] text-slate-500">{note}</span>}
    </span>
  );
}

// Dismissing an owed promise asks why in one tap, the way a dismissed draft
// does: the nightly coach reads the answer. A second press skips the why.
function DismissPromise({ op, item, onDone }) {
  const [askWhy, setAskWhy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  async function go(code = "") {
    setBusy(true); setNote("");
    try {
      const r = await runOp(op.key, item, code ? { reason: { code } } : null);
      setNote(describeResult(op.key, r));
      onDone?.();
    } catch (e) {
      setNote(e.message || "That didn't work.");
    } finally { setBusy(false); }
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" className={BTN} disabled={busy} onClick={() => (askWhy ? go() : setAskWhy(true))}>
        {busy ? "…" : askWhy ? "Just dismiss" : op.label}
      </button>
      {askWhy && (
        <span className="flex max-w-xs flex-wrap justify-end gap-1" role="group" aria-label="Why dismiss it">
          {PROMISE_DISMISS_REASONS.map((code) => (
            <button key={code} type="button" disabled={busy} onClick={() => go(code)}
              className="rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50">
              {PROMISE_DISMISS_LABEL[code]}
            </button>
          ))}
        </span>
      )}
      {note && <span className="text-[11px] text-slate-500">{note}</span>}
    </span>
  );
}

// A question the bot couldn't answer. What is typed here goes to them in the
// bot's voice (as a draft, so Send is still yours) and is kept so the bot
// answers it itself next time.
function AnswerBox({ item, onDone }) {
  const [text, setText] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(null);
  async function send() {
    setBusy(true); setNote("");
    try {
      const r = await answerPartnerQuestion({ contactId: item.contactId, draftId: item.fromDraftId, address: item.address, question: item.question, answer: text, saveAsFact: keep });
      if (!r.started) { setNote(`Didn't draft it: ${r.skipped}`); return; }
      setDone(r);
      onDone?.();
    } catch (e) {
      setNote(e.message || "That didn't work.");
    } finally { setBusy(false); }
  }
  async function undo() {
    setBusy(true);
    try { await forgetStandingAnswer(done.savedAnswerId); setDone({ ...done, savedAnswerId: null, undone: true }); }
    catch (e) { setNote(e.message || "Couldn't undo that."); }
    finally { setBusy(false); }
  }
  if (done) {
    return (
      <div className="w-full rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Drafting your answer now. It lands under Drafts waiting on you, for your Send.
        {done.savedAnswerId && <> Kept for next time. <button type="button" className="text-blue-700 underline" disabled={busy} onClick={undo}>Undo</button></>}
        {done.undone && " Not kept."}
        {done.notSaved && ` Not kept: ${done.notSaved}.`}
      </div>
    );
  }
  return (
    <div className="w-full space-y-1.5">
      <label className="block text-xs font-medium text-slate-600" htmlFor={`answer-${item.id}`}>They asked: “{item.question}”</label>
      <textarea id={`answer-${item.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={600}
        placeholder="Your answer, in your own words. The bot puts it in its voice."
        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm" />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Save for next time, so the bot answers this itself
        </label>
        {keep && answerNamesMoney(text) && <span className="text-xs text-amber-700">This names a dollar amount. The bot will draft it next time, but it will wait for you each time.</span>}
        {note && <span className="text-xs text-red-700">{note}</span>}
        <button type="button" className={`${BTN_PRIMARY} ml-auto`} disabled={busy || !text.trim()} onClick={send}>{busy ? "…" : "Draft the reply"}</button>
      </div>
    </div>
  );
}

function ActionRow({ item, onDone, onShowDraft, draft, sendsEnabled, serverOffsetMs }) {
  const sev = SEV[item.severity] || SEV.fyi;
  const drawer = useOpenContact();
  const [showing, setShowing] = useState(false);
  // The audit's rows open somewhere rather than do something: the thread is
  // the contact's record; the draft opens right here when the board has it,
  // and in their record (which lists their drafts) when it doesn't.
  function openContact() {
    if (!item.contactId) return;
    if (drawer) drawer.open(item.contactId, { party: "agent", name: item.contactName || null });
    else window.open(ghlContactUrl(item.contactId), "_blank", "noreferrer");
  }
  const OPENERS = {
    open_contact: openContact,
    open_outbox: () => (draft ? setShowing((v) => !v) : openContact()),
  };
  return (
    <li className="flex flex-wrap items-start gap-3 px-3 py-2.5">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sev.dot}`} title={sev.label} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-800">{item.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
          {item.contactId && <ContactLink contactId={item.contactId} name={item.contactName || "contact"} party={item.kind.startsWith("deal") || item.kind === "blast_no_opens" ? "investor" : "agent"} stopPropagation />}
          {item.address && (item.offerId
            ? <a href={linkFor("open_editor", item)} target="_blank" rel="noreferrer" title="Open the offer" className="text-blue-700 hover:underline">{item.address}</a>
            : <span>{item.address}</span>)}
          {item.detail && <span className="text-slate-400">· {item.detail}</span>}
        </div>
        {item.next?.what && (
          <div className="mt-0.5 text-xs text-violet-700">Next: {item.next.what}{item.next.at ? ` · ${whenLabel(item.next.at)}` : ""}</div>
        )}
        {item.group === "stuck" && item.why && <div className="mt-0.5 text-xs text-amber-700">Stuck because: {item.why}</div>}
      </div>
      <div className="flex flex-wrap items-start gap-1.5">
        {item.ops.filter((op) => op.key !== "answer").map((op) => op.key === "show_draft"
          ? <button key={op.key} type="button" className={BTN} onClick={() => onShowDraft?.(item.draftId)}>{op.label}</button>
          : OPENERS[op.key]
          ? <button key={op.key} type="button" className={op.intent === "primary" ? BTN_PRIMARY : BTN} onClick={OPENERS[op.key]}>{showing && op.key === "open_outbox" ? "Hide the draft" : op.label}</button>
          : op.key === "dismiss_promise"
          ? <DismissPromise key={op.key} op={op} item={item} onDone={onDone} />
          : <OpButton key={op.key} op={op} item={item} onDone={onDone} />)}
      </div>
      {item.question && item.ops.some((op) => op.key === "answer") && <AnswerBox item={item} onDone={onDone} />}
      {showing && draft && (
        <ul className="w-full rounded-lg border border-slate-100">
          <DraftRow draft={draft} offerId={item.offerId} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} onDone={onDone} />
        </ul>
      )}
    </li>
  );
}

function KindGroups({ items, draftsById, sendsEnabled, serverOffsetMs, onDone, highlightDraftId, onShowDraft, quiet = false }) {
  const groups = [...ACTION_KINDS, ...AUDIT_ACTION_KINDS]
    .map((k) => ({ ...k, items: items.filter((a) => a.kind === k.key) }))
    .filter((g) => g.items.length);
  return (
    <div className="space-y-2">
      {groups.map((g) => {
        const now = g.items.filter((i) => i.severity === "now").length;
        const open = !quiet && (now > 0 || g.items.some((i) => i.draftId === highlightDraftId));
        return (
          <details key={g.key} open={open} className="group rounded-xl border border-slate-200 bg-white">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-semibold">
              <ChevronDown size={14} className="text-slate-400 transition-transform group-open:rotate-180" />
              {g.label}
              <Pill small label={String(g.items.length)} />
              {!quiet && now > 0 && <Pill small label={`${now} now`} cls={SEV.now.cls} />}
            </summary>
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {g.items.map((item) => {
                if (DRAFT_KINDS.has(g.key) && draftsById[item.draftId]) {
                  return (
                    <li key={item.id} className={item.draftId === highlightDraftId ? "ring-2 ring-inset ring-blue-300" : ""} id={`draft-${item.draftId}`}>
                      <ul><DraftRow draft={draftsById[item.draftId]} offerId={item.offerId} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} onDone={onDone} /></ul>
                    </li>
                  );
                }
                return <ActionRow key={item.id} item={item} onDone={onDone} onShowDraft={onShowDraft}
                  draft={item.draftId ? draftsById[item.draftId] : null} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} />;
              })}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

// Three groups (shared/pipeline.js ACTION_GROUPS): your call, the machine is
// on it, stuck. Inside each, the same kind-by-kind sections as before. An
// action with no group (an older broker) is yours.
export default function ActionQueue({ actions = [], draftsById = {}, sendsEnabled, serverOffsetMs = 0, onDone, highlightDraftId, onShowDraft }) {
  const by = (key) => actions.filter((a) => (a.group || "yours") === key);
  const rowProps = { draftsById, sendsEnabled, serverOffsetMs, onDone, highlightDraftId, onShowDraft };
  const yours = by("yours"), machine = by("machine"), stuck = by("stuck");
  return (
    <div className="space-y-5">
      <section aria-label={ACTION_GROUPS[0].label}>
        <GroupHeading group="yours" count={yours.length} />
        {yours.length
          ? <KindGroups items={yours} {...rowProps} />
          : <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">Nothing is waiting on you.</div>}
      </section>
      {stuck.length > 0 && (
        <section aria-label={ACTION_GROUPS[2].label}>
          <GroupHeading group="stuck" count={stuck.length} />
          <KindGroups items={stuck} {...rowProps} />
        </section>
      )}
      {machine.length > 0 && (
        <details className="group/m" open={machine.some((i) => i.draftId && i.draftId === highlightDraftId)}>
          <summary className="flex cursor-pointer list-none items-baseline gap-2">
            <ChevronDown size={14} className="self-center text-slate-400 transition-transform group-open/m:rotate-180" />
            <GroupHeading group="machine" count={machine.length} inline />
          </summary>
          <div className="mt-2"><KindGroups items={machine} {...rowProps} quiet /></div>
        </details>
      )}
    </div>
  );
}

function GroupHeading({ group, count, inline = false }) {
  const g = ACTION_GROUPS.find((x) => x.key === group);
  return (
    <div className={inline ? "flex flex-wrap items-baseline gap-2" : "mb-2 flex flex-wrap items-baseline gap-2"}>
      <h3 className="text-sm font-bold text-slate-800">{g.label}</h3>
      <Pill small label={String(count)} />
      <span className="text-xs text-slate-500">{GROUP_HINT[group]}</span>
    </div>
  );
}
