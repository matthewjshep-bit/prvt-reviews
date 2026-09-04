// ConversationPlaybooks.jsx — the editors: who the bot is, how it tells an
// agent from an investor, what it may do for each, and when it may send on
// its own. Pure editing of a config object; the tab owns loading and saving.

import React, { useEffect, useState } from "react";
import { Lock, Plus, Trash2 } from "lucide-react";
import {
  INTENTS, INTENT_LABEL, INTENT_GLOSS, NEVER_AUTO, PARTY_LABEL, ACTION_LABEL, ACTION_TYPES,
  INTERNAL_ACTIONS, INTERNAL_ACTIONS_FOR, ASK_ONLY_ACTIONS, TOKENS,
} from "@shared/conversation-ai.js";
import { BTN } from "./ui.jsx";

export const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";
const CARD = "rounded-xl border border-slate-200 bg-white p-4";
const HINT = "mt-1 text-xs text-slate-400";

export function Section({ title, intro, children }) {
  return (
    <section className={CARD}>
      <h2 className="mb-1 text-sm font-bold">{title}</h2>
      {intro && <p className="mb-3 text-xs text-slate-500">{intro}</p>}
      {children}
    </section>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className={LABEL_CLS}>{label}</span>
      {children}
      {hint && <p className={HINT}>{hint}</p>}
    </label>
  );
}

function Text({ value, onChange, placeholder, type = "text" }) {
  return <input type={type} className={INPUT_CLS} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function Area({ value, onChange, placeholder, rows = 3 }) {
  return <textarea className={`${INPUT_CLS} resize-y`} rows={rows} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function Select({ value, onChange, options }) {
  return (
    <select className={INPUT_CLS} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}

function Toggle({ checked, onChange, children }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700">
      <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

// A comma list typed as text. The text is local so a trailing comma survives
// the keystroke; `version` bumps when the config is replaced from the server.
function TagList({ value = [], onChange, placeholder, version }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => { setText((value || []).join(", ")); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input className={INPUT_CLS} value={text} placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(",").map((t) => t.trim()).filter(Boolean));
      }} />
  );
}

/* ---------- persona ---------- */

export function PersonaCard({ config, patch }) {
  const p = config.persona;
  const set = (k) => (v) => patch({ persona: { ...p, [k]: v } });
  return (
    <Section title="Who the bot is"
      intro="It answers in the first person as this person. The other side is talking to a human and is never told otherwise.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="How it signs and who it is. Defaults to the signer on your letterhead.">
          <Text value={p.name} onChange={set("name")} placeholder="Matt" />
        </Field>
        <Field label="Role, in a phrase" hint="What it tells people it does, if asked.">
          <Text value={p.role} onChange={set("role")} placeholder="a local cash buyer who closes fast and sells deals to a small list of investors" />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Voice" hint="Describe it the way you'd brief a new assistant. Plain words beat adjectives: 'texts like a busy person who is easy to work with'.">
          <Area value={p.voice} onChange={set("voice")} rows={3}
            placeholder="Short, plain, warm. Sounds like a busy investor who respects the agent's time. Never salesy. Says 'we' about the company and 'I' about myself." />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="If they ask whether it's a bot" hint="Left blank, it never admits to being one. Filled in, it answers with exactly this line and carries on — the compliant choice.">
          <Text value={p.ifAskedIfBot} onChange={set("ifAskedIfBot")} placeholder="I'm an assistant on Matt's team keeping up with texts! Happy to help either way." />
        </Field>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Length">
          <Select value={p.length} onChange={set("length")} options={[["short", "Short (1–3 sentences)"], ["medium", "Medium (2–5)"], ["long", "As long as it needs"]]} />
        </Field>
        <Field label="Sign-off" hint="Blank means none — most texts don't have one.">
          <Text value={p.signOff} onChange={set("signOff")} placeholder="— Matt" />
        </Field>
        <div className="flex items-end pb-2">
          <Toggle checked={p.useFirstName} onChange={set("useFirstName")}>Use their first name (once at most)</Toggle>
        </div>
      </div>
    </Section>
  );
}

/* ---------- rules + examples ---------- */

export function RulesEditor({ config, patch }) {
  const rules = config.rules || [];
  const update = (i, v) => patch({ rules: rules.map((r, j) => (j === i ? v : r)) });
  return (
    <Section title="House rules — never"
      intro="Lines it may not cross, whoever is texting. One per row. These sit above everything else in the prompt.">
      <div className="space-y-2">
        {rules.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className={INPUT_CLS} value={r} onChange={(e) => update(i, e.target.value)} placeholder="Never say who the end buyer is." />
            <button type="button" className={BTN} aria-label="Remove rule" onClick={() => patch({ rules: rules.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>
          </div>
        ))}
        <button type="button" className={BTN} onClick={() => patch({ rules: [...rules, ""] })}><Plus size={13} /> Add a rule</button>
      </div>
    </Section>
  );
}

export function ExamplesEditor({ config, patch }) {
  const ex = config.examples || [];
  const update = (i, k, v) => patch({ examples: ex.map((e, j) => (j === i ? { ...e, [k]: v } : e)) });
  return (
    <Section title="Examples of our voice"
      intro="A few real exchanges teach tone better than any description. The model matches the tone, not the facts — numbers still come only from the records.">
      <div className="space-y-3">
        {ex.map((e, i) => (
          <div key={e.id || i} className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 flex items-center gap-2">
              <select className="rounded-lg border border-slate-300 px-2 py-1 text-xs" value={e.party} onChange={(ev) => update(i, "party", ev.target.value)}>
                <option value="any">Either party</option>
                <option value="agent">Agents</option>
                <option value="investor">Investors</option>
              </select>
              <button type="button" className={`${BTN} ml-auto`} aria-label="Remove example" onClick={() => patch({ examples: ex.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="They said"><Area rows={2} value={e.theySaid} onChange={(v) => update(i, "theySaid", v)} placeholder="you guys still buying?" /></Field>
              <Field label="We'd say"><Area rows={2} value={e.weSay} onChange={(v) => update(i, "weSay", v)} placeholder="Always. Send me the address and I'll have a number back today." /></Field>
            </div>
          </div>
        ))}
        <button type="button" className={BTN} onClick={() => patch({ examples: [...ex, { id: `ex-${Date.now().toString(36)}`, party: "any", theySaid: "", weSay: "" }] })}>
          <Plus size={13} /> Add an example
        </button>
      </div>
    </Section>
  );
}

/* ---------- routing ---------- */

export function RoutingCard({ config, patch, version }) {
  const r = config.routing;
  const set = (k) => (v) => patch({ routing: { ...r, [k]: v } });
  return (
    <Section title="Who is who"
      intro="An inbound text is routed by the contact's GHL tags. Comma-separated; * matches anything, so agent-* covers agent-hot, agent-warm and agent-cold.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Listing-agent tags">
          <TagList value={r.agentTags} onChange={set("agentTags")} placeholder="agent, agent-*" version={version} />
        </Field>
        <Field label="Investor tags">
          <TagList value={r.investorTags} onChange={set("investorTags")} placeholder="investor, investor-*, on-deal" version={version} />
        </Field>
        <Field label="Hands-off tags" hint="A contact carrying one is yours: no draft, no send, nothing. Tag them in GHL when you take a thread over.">
          <TagList value={r.botOffTags} onChange={set("botOffTags")} placeholder="stop bot, bot-off" version={version} />
        </Field>
        <Field label="If a contact carries both" hint="A buyer who is also an agent gets the playbook you pick here.">
          <Select value={r.priority} onChange={set("priority")} options={[["agent", "Treat as a listing agent"], ["investor", "Treat as an investor"]]} />
        </Field>
        <Field label="If a contact carries neither" hint="Hold leaves a note and writes no draft. Classify reads the message the way your old master bot did, then answers from that playbook; when the words don't settle it, it drafts the generic reply below. Generic skips the read.">
          <Select value={r.unknown} onChange={set("unknown")} options={[["classify", "Work it out from the message"], ["hold", "Hold — a person answers"], ["generic", "Draft a generic reply"]]} />
        </Field>
      </div>
      {r.unknown === "classify" && (
        <div className="mt-3">
          <Toggle checked={r.tagOnClassify} onChange={set("tagOnClassify")}>
            When the message settles it, tag the contact ({(r.agentTags || []).find((t) => !t.includes("*")) || "agent"} / {(r.investorTags || []).find((t) => !t.includes("*")) || "investor"}) so the tags decide next time
          </Toggle>
        </div>
      )}
      {(r.unknown === "generic" || r.unknown === "classify") && (
        <div className="mt-3">
          <Field label={r.unknown === "classify" ? "When the message doesn't settle it, reply with" : "Instructions for an unknown contact"}
            hint="One natural question a rep would ask. Never a number, never a department. This reply never auto-sends.">
            <Area value={r.genericInstructions} onChange={set("genericInstructions")} rows={2} placeholder="Ask one natural question that tells you which side they're on. Commit to nothing." />
          </Field>
        </div>
      )}
    </Section>
  );
}

/* ---------- auto-send timing ---------- */

export function AutoSendCard({ config, patch }) {
  const a = config.autoSend;
  const set = (k) => (v) => patch({ autoSend: { ...a, [k]: v } });
  const setQh = (k) => (v) => patch({ autoSend: { ...a, quietHours: { ...a.quietHours, [k]: v } } });
  const toggleChannel = (c) => (on) => set("channels")(on ? [...new Set([...a.channels, c])] : a.channels.filter((x) => x !== c));
  return (
    <Section title="When it sends on its own"
      intro="A reply that lands two seconds after the text reads as a bot. Approved replies wait a few human minutes — your window to hold them from the outbox — and only inside the hours a person would be at their phone.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Delay, at least (seconds)"><Text type="number" value={a.delayMinSec} onChange={(v) => set("delayMinSec")(Number(v))} /></Field>
        <Field label="Delay, at most (seconds)"><Text type="number" value={a.delayMaxSec} onChange={(v) => set("delayMaxSec")(Number(v))} /></Field>
        <Field label="Sends from"><Text type="time" value={a.quietHours.start} onChange={setQh("start")} /></Field>
        <Field label="Until"><Text type="time" value={a.quietHours.end} onChange={setQh("end")} /></Field>
        <Field label="Time zone" hint="An IANA name. Outside the window a reply waits for the next opening.">
          <Text value={a.quietHours.timeZone} onChange={setQh("timeZone")} placeholder="America/Los_Angeles" />
        </Field>
        <Field label="Wait for follow-up texts (seconds)" hint="Three texts in a row get one reply to all three. 0 drafts at once.">
          <Text type="number" value={a.debounceSec} onChange={(v) => set("debounceSec")(Number(v))} />
        </Field>
        <Field label="Stand down after you reply (minutes)" hint="If a person replied to them this recently, the bot drafts but never sends itself.">
          <Text type="number" value={a.humanActiveMin} onChange={(v) => set("humanActiveMin")(Number(v))} />
        </Field>
        <div className="flex flex-col justify-end gap-1 pb-1">
          <Toggle checked={a.channels.includes("sms")} onChange={toggleChannel("sms")}>Texts may auto-send</Toggle>
          <Toggle checked={a.channels.includes("email")} onChange={toggleChannel("email")}>Emails may auto-send</Toggle>
        </div>
      </div>
    </Section>
  );
}

/* ---------- texting rules, opt-outs, photos ---------- */

export function StyleCard({ config, patch }) {
  const st = config.style;
  const set = (k) => (v) => patch({ style: { ...st, [k]: v } });
  return (
    <Section title="Texting rules"
      intro="Carrier spam filters key on dollar signs and links; an em dash is what a bot sounds like. The first two hold a draft that breaks them, the third is scrubbed from the draft. Emails are exempt.">
      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle checked={st.noDollarSigns} onChange={set("noDollarSigns")}>No dollar signs in texts — write 525k, not $525,000</Toggle>
        <Toggle checked={st.noLinks} onChange={set("noLinks")}>No links in texts</Toggle>
        <Toggle checked={st.noEmDashes} onChange={set("noEmDashes")}>No em dashes</Toggle>
        <Field label="Longest text it may send (characters)" hint="A draft over this holds. The voice above sets the target; this is the ceiling.">
          <Text type="number" value={st.maxSmsChars} onChange={(v) => set("maxSmsChars")(Number(v))} />
        </Field>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 border-t border-slate-100 pt-3">
        <Toggle checked={config.notes.onDraft} onChange={(v) => patch({ notes: { ...config.notes, onDraft: v } })}>Leave a GHL note on every draft</Toggle>
        <Toggle checked={config.notes.onAutoSend} onChange={(v) => patch({ notes: { ...config.notes, onAutoSend: v } })}>Leave a GHL note when it sends itself</Toggle>
      </div>
    </Section>
  );
}

export function ProfileCard({ config, patch }) {
  const pr = config.profile;
  const set = (k) => (v) => patch({ profile: { ...pr, [k]: v } });
  return (
    <Section title="Memory"
      intro="It reads the texts and the recent call transcripts, files what is new about the person into their CRM fields (personal details, areas, the properties they've sent, an investor's buy box) through the same merge rules the nightly sweep uses, and leans on it in the reply — once, lightly, the way a colleague who remembers would.">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex items-end pb-2"><Toggle checked={pr.enabled} onChange={set("enabled")}>Build their profile as we talk</Toggle></div>
        <Field label="Call transcripts to read" hint="The most recent recorded calls, when GHL has transcribed them.">
          <Text type="number" value={pr.callTranscripts} onChange={(v) => set("callTranscripts")(Number(v))} />
        </Field>
        <div className="flex items-end pb-2"><Toggle checked={pr.writeSummary} onChange={set("writeSummary")}>Keep "last conversation" current</Toggle></div>
      </div>
    </Section>
  );
}

export function OptOutCard({ config, patch, version, workflows }) {
  const o = config.optOut;
  const set = (k) => (v) => patch({ optOut: { ...o, [k]: v } });
  return (
    <Section title="Opt-outs"
      intro="A text that starts with one of these words, or contains one of these phrases, gets silence — no goodbye, no confirmation — plus the tags below. Any reply counting down to that contact is cancelled. The model can also read an opt-out the words didn't catch ('lose my number', plain anger); it ends the same way.">
      <Toggle checked={o.enabled} onChange={set("enabled")}>Handle opt-outs before anything else</Toggle>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Words and phrases" hint="Comma-separated. A single word must start the message; a phrase may appear anywhere.">
          <TagList value={o.keywords} onChange={set("keywords")} version={version} placeholder="stop, unsubscribe, wrong number" />
        </Field>
        <Field label="Tags to add" hint="Point a GHL workflow at one of these to set DND.">
          <TagList value={o.tags} onChange={set("tags")} version={version} placeholder="stop bot, dnc" />
        </Field>
        <Field label="Tags to remove">
          <TagList value={o.removeTags} onChange={set("removeTags")} version={version} placeholder="tier-1, tier-2" />
        </Field>
        <Field label="Workflow to add them to" hint="Optional.">
          {workflows?.list?.length ? (
            <Select value={o.workflowId} onChange={set("workflowId")} options={[["", "None"], ...workflows.list.map((w) => [w.id, w.name])]} />
          ) : (
            <Text value={o.workflowId} onChange={set("workflowId")} placeholder="workflow id (optional)" />
          )}
        </Field>
      </div>
    </Section>
  );
}

export function MediaCard({ config, patch }) {
  return (
    <Section title="Photos and attachments"
      intro="A message that is only a photo gets this line back and nothing else. The image is never looked at, which is the surest way never to describe it.">
      <Field label="Reply to a bare photo">
        <Text value={config.media.reply} onChange={(v) => patch({ media: { ...config.media, reply: v } })} placeholder="Thanks for the images, taking a look!" />
      </Field>
    </Section>
  );
}

/* ---------- per-party playbooks ---------- */

export function PartyPlaybooks({ config, patch, workflows }) {
  const [party, setParty] = useState("agent");
  const pb = config.parties[party];
  const setPb = (next) => patch({ parties: { ...config.parties, [party]: { ...pb, ...next } } });
  const eligible = INTENTS[party].filter((i) => !NEVER_AUTO[party].includes(i));
  return (
    <Section title="Playbooks"
      intro="What it knows to do for each kind of contact. An agent is answered about your offers; an investor about your deals and their buy box.">
      <div className="mb-3 inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
        {["agent", "investor"].map((p) => (
          <button key={p} type="button" onClick={() => setParty(p)} aria-pressed={party === p}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${party === p ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            {PARTY_LABEL[p]}s
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <Field label="Standing instructions" hint="Your rules for this party, in plain English. Add a line each time a draft gets something wrong.">
          <Area rows={4} value={pb.instructions} onChange={(v) => setPb({ instructions: v })}
            placeholder={party === "agent"
              ? "We buy as-is, cash, close in 14–21 days, no financing or inspection contingency. If they ask for proof of funds, say we'll send it with the contract. Never discuss our assignment fee or who the end buyer is."
              : "We assign contracts; the buyer price is the price. Deals go out with a dataroom link, never photos by text. If they want to walk it, say we'll set a time today."} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="It may, on its own" hint="Things it can say yes to without asking you.">
            <Area rows={2} value={pb.mayCommit} onChange={(v) => setPb({ mayCommit: v })}
              placeholder={party === "agent" ? "Confirm an offer is still open. Say we can close in 14 days." : "Say a deal is still available. Offer to send the dataroom link."} />
          </Field>
          <Field label="It may not, ever" hint="On top of the built-in rule that it never commits to a number, a time or a document.">
            <Area rows={2} value={pb.mayNotCommit} onChange={(v) => setPb({ mayNotCommit: v })}
              placeholder={party === "agent" ? "Name the end buyer. Waive earnest money." : "Quote our fee. Promise a deal to one buyer."} />
          </Field>
        </div>

        <div className="rounded-lg border border-slate-200 p-3">
          <Toggle checked={pb.autoSend.enabled} onChange={(v) => setPb({ autoSend: { ...pb.autoSend, enabled: v } })}>
            <span className="font-semibold">Let it send on its own to {PARTY_LABEL[party].toLowerCase()}s</span>
          </Toggle>
          <p className={HINT}>Only for the intents ticked below, only when every gate passes, and only after the delay above. Everything else still waits for you.</p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {INTENTS[party].map((intent) => {
              const locked = NEVER_AUTO[party].includes(intent);
              const on = pb.autoSend.intents.includes(intent);
              return (
                <label key={intent} className={`flex items-start gap-2 text-sm ${locked ? "text-slate-400" : "text-slate-700"}`}
                  title={locked ? "Never on its own — this commits you to something" : INTENT_GLOSS[party][intent]}>
                  {locked
                    ? <Lock size={13} className="mt-1 shrink-0" />
                    : <input type="checkbox" className="mt-1" checked={on} disabled={!pb.autoSend.enabled}
                        onChange={(e) => setPb({ autoSend: { ...pb.autoSend, intents: e.target.checked ? [...pb.autoSend.intents, intent] : pb.autoSend.intents.filter((x) => x !== intent) } })} />}
                  <span>
                    <span className="font-medium">{INTENT_LABEL[party][intent]}</span>
                    <span className="block text-xs text-slate-400">{INTENT_GLOSS[party][intent]}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {eligible.length > 0 && <p className={HINT}>Locked intents can never auto-send, whatever you tick.</p>}
        </div>

        <IntentRulesTable party={party} pb={pb} setPb={setPb} workflows={workflows} />
        <FallbackEditor party={party} pb={pb} setPb={setPb} workflows={workflows} />
      </div>
    </Section>
  );
}

// The catch-all: what happens when no rule above matched. The old GHL bot
// put every agent reply with no fit into Tier 3 this way.
function FallbackEditor({ party, pb, setPb, workflows }) {
  const fb = pb.fallback || { mode: "ask", actions: [], unlessTags: [] };
  const set = (next) => setPb({ fallback: { ...fb, ...next } });
  const allowedTypes = ACTION_TYPES.filter((t) => !INTERNAL_ACTIONS.has(t) || (INTERNAL_ACTIONS_FOR[party] || []).includes(t));
  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">When no rule above matched</span>
        <select className="rounded-lg border border-slate-300 px-2 py-1 text-xs" value={fb.mode} onChange={(e) => set({ mode: e.target.value })}>
          <option value="auto">automatically</option>
          <option value="ask">ask me first</option>
        </select>
        <span className="text-xs text-slate-400">unless they already carry</span>
        <input className="w-56 rounded-lg border border-slate-300 px-2 py-1 text-xs" placeholder="tier-1, tier-2, tier-3"
          defaultValue={(fb.unlessTags || []).join(", ")}
          onChange={(e) => set({ unlessTags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} />
      </div>
      <div className="mt-2 space-y-2">
        {(fb.actions || []).map((a, i) => (
          <ActionEditor key={i} action={a} party={party} allowedTypes={allowedTypes} workflows={workflows}
            onChange={(next) => set({ actions: fb.actions.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => set({ actions: fb.actions.filter((_, j) => j !== i) })} />
        ))}
        {(fb.actions || []).length < 8 && (
          <button type="button" className={BTN} onClick={() => set({ actions: [...(fb.actions || []), { type: "add_tags", tags: [] }] })}>
            <Plus size={13} /> Add a catch-all action
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- intent → actions ---------- */

function IntentRulesTable({ party, pb, setPb, workflows }) {
  const rules = pb.intentRules || {};
  const setRule = (intent, next) => {
    const all = { ...rules };
    if (!next) delete all[intent]; else all[intent] = next;
    setPb({ intentRules: all });
  };
  const allowedTypes = ACTION_TYPES.filter((t) => !INTERNAL_ACTIONS.has(t) || (INTERNAL_ACTIONS_FOR[party] || []).includes(t));
  return (
    <div>
      <div className={LABEL_CLS}>When it hears… do…</div>
      <p className="mb-2 text-xs text-slate-500">
        Each intent can add or remove tags, set a field, drop the contact into a GHL workflow, or run one of the broker's own moves.
        <strong> Automatically</strong> fires the moment the model is sure; <strong>ask me first</strong> shows it on the draft row for one click.
        A dataroom link is always ask-first.
      </p>
      {workflows?.scopeMissing && (
        <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{workflows.error}</p>
      )}
      <div className="space-y-2">
        {INTENTS[party].map((intent) => {
          const rule = rules[intent] || null;
          return (
            <div key={intent} className="rounded-lg border border-slate-200 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium" title={INTENT_GLOSS[party][intent]}>{INTENT_LABEL[party][intent]}</span>
                {rule ? (
                  <>
                    <select className="rounded-lg border border-slate-300 px-2 py-1 text-xs" value={rule.mode}
                      disabled={rule.actions.some((a) => ASK_ONLY_ACTIONS.has(a.type))}
                      onChange={(e) => setRule(intent, { ...rule, mode: e.target.value })}>
                      <option value="auto">automatically</option>
                      <option value="ask">ask me first</option>
                    </select>
                    <button type="button" className={`${BTN} ml-auto`} onClick={() => setRule(intent, null)}><Trash2 size={13} /> Clear</button>
                  </>
                ) : (
                  <button type="button" className={`${BTN} ml-auto`} onClick={() => setRule(intent, { mode: "ask", actions: [{ type: "add_tags", tags: [] }] })}>
                    <Plus size={13} /> Add actions
                  </button>
                )}
              </div>
              {rule && (
                <div className="mt-2 space-y-2">
                  {rule.actions.map((a, i) => (
                    <ActionEditor key={i} action={a} party={party} allowedTypes={allowedTypes} workflows={workflows}
                      onChange={(next) => setRule(intent, { ...rule, actions: rule.actions.map((x, j) => (j === i ? next : x)) })}
                      onRemove={() => setRule(intent, rule.actions.length > 1 ? { ...rule, actions: rule.actions.filter((_, j) => j !== i) } : null)} />
                  ))}
                  {rule.actions.length < 8 && (
                    <button type="button" className={BTN} onClick={() => setRule(intent, { ...rule, actions: [...rule.actions, { type: "add_tags", tags: [] }] })}>
                      <Plus size={13} /> Another action
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionEditor({ action: a, allowedTypes, workflows, onChange, onRemove }) {
  const setType = (type) => onChange({ type, ...(type === "add_tags" || type === "remove_tags" ? { tags: [] } : {}), ...(type === "set_field" ? { key: "", value: "" } : {}), ...(type === "add_to_workflow" || type === "remove_from_workflow" ? { workflowId: "", workflowName: "" } : {}) });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className="rounded-lg border border-slate-300 px-2 py-1 text-xs" value={a.type} onChange={(e) => setType(e.target.value)}>
        {allowedTypes.map((t) => <option key={t} value={t}>{ACTION_LABEL[t]}</option>)}
      </select>
      {(a.type === "add_tags" || a.type === "remove_tags") && (
        <input className="min-w-[14rem] flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs" placeholder="tags, comma-separated"
          defaultValue={(a.tags || []).join(", ")}
          onChange={(e) => onChange({ ...a, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} />
      )}
      {a.type === "set_field" && (
        <>
          <input className="w-40 rounded-lg border border-slate-300 px-2 py-1 text-xs" placeholder="field key" value={a.key || ""}
            onChange={(e) => onChange({ ...a, key: e.target.value })} />
          <input className="min-w-[12rem] flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs" placeholder={`value — tokens: ${TOKENS.map((t) => `{{${t}}}`).join(" ")}`}
            value={a.value || ""} onChange={(e) => onChange({ ...a, value: e.target.value })} />
        </>
      )}
      {(a.type === "add_to_workflow" || a.type === "remove_from_workflow") && (
        workflows?.list?.length ? (
          <select className="min-w-[14rem] flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs" value={a.workflowId || ""}
            onChange={(e) => { const w = workflows.list.find((x) => x.id === e.target.value); onChange({ ...a, workflowId: e.target.value, workflowName: w?.name || "" }); }}>
            <option value="">Pick a workflow…</option>
            {workflows.list.map((w) => <option key={w.id} value={w.id}>{w.name}{w.status && w.status !== "published" ? ` (${w.status})` : ""}</option>)}
          </select>
        ) : (
          <input className="min-w-[14rem] flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs"
            placeholder={workflows?.loading ? "loading workflows…" : "workflow id (the list needs the workflows.readonly scope)"}
            value={a.workflowId || ""} onChange={(e) => onChange({ ...a, workflowId: e.target.value })} />
        )
      )}
      {INTERNAL_ACTIONS.has(a.type) && <span className="text-xs text-slate-400">runs on the broker</span>}
      <button type="button" className={BTN} aria-label="Remove action" onClick={onRemove}><Trash2 size={13} /></button>
    </div>
  );
}
