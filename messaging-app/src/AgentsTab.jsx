// AgentsTab.jsx — Autopilot → Agents (2026-10-20): what goes out to a
// listing agent, in order, editable in place; the agent list (what was
// Agent Outreach) and its setup folded away below.
//
// The texts save through PATCH /settings (outreachAutopilot.opener, .pulse,
// .introEmail and .checkInEmail only), the follow-up days and the check-in repeat through
// the Conversation AI config (parties.agent.followUp.ladders.outreach_nudge
// .steps and .repeatEvery), each re-read before it's written, so neither
// carries an old copy of anything else.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { agentFlow } from "@shared/autopilot-flows.js";
import { NUDGE_TEXTS } from "@shared/standard-texts.js";
import { OPENER_MAX_EXAMPLES, homesFrom, homesText, normalizeOpener } from "@shared/outreach-opener.js";
import { normalizeIntroEmail, normalizeCheckInEmail, CHECK_IN_EMAIL_MAX } from "@shared/outreach-email.js";
import { MAX_REPEAT_DAYS } from "@shared/follow-up.js";
import { getConversationAi, getDashboardPipeline, getSettings, patchSettings, saveConversationAi } from "./api.js";
import { BTN, BTN_DANGER, BTN_PRIMARY, ErrorBar, SkeletonRows } from "./ui.jsx";
import FlowChart, { emailSampleOf, sampleOf, textWarnings } from "./FlowChart.jsx";
import AgentOutreach from "./AgentOutreach.jsx";
import SettingsView from "./SettingsView.jsx";

const AREA = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm leading-snug focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";
const NUM = "w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm";
const MAX_FOLLOW_UPS = 6;

/** A text box with what it reads like filled in, and what would stop it. */
function TextBox({ value, onChange, onRemove, label }) {
  const warn = textWarnings(value);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {label && <span className="text-xs font-semibold text-slate-600">{label}</span>}
        {onRemove && (
          <button type="button" className={`${BTN_DANGER} ml-auto`} onClick={onRemove} title="Remove this one">
            <Trash2 size={12} aria-hidden="true" /> Remove
          </button>
        )}
      </div>
      <textarea className={AREA} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      <p className="text-xs text-slate-500">Reads: {sampleOf(value) || "—"}</p>
      {warn.map((w) => <p key={w} className="text-xs font-medium text-amber-700">{w}</p>)}
    </div>
  );
}

function EditorBar({ busy, onSave, onCancel, children }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={onSave}>
        {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Save
      </button>
      <button type="button" className={BTN} disabled={busy} onClick={onCancel}><X size={12} aria-hidden="true" /> Cancel</button>
      {children}
    </div>
  );
}

const HELP = "{first} is their first name, {address} the listing's street address, {street} the street alone, {county} the county, {home} the city we say we're in. GHL's {{contact.first_name}} style works too.";

export default function AgentsTab({ settings: appSettings, onSettingsSaved }) {
  const [settings, setSettings] = useState(null);
  const [config, setConfig] = useState(null);
  const [switches, setSwitches] = useState([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  // Setup's form is read once when it mounts; a chart save remounts it, so a
  // Setup save after never carries the old texts back.
  const [setupVersion, setSetupVersion] = useState(0);

  const load = useCallback(() => Promise.all([getSettings(), getConversationAi(), getDashboardPipeline().catch(() => null)])
    .then(([s, c, p]) => { setSettings(s); setConfig(c.config); setSwitches(p?.autopilot?.switches || []); setError(""); })
    .catch((e) => setError(e.message || "Couldn't load the agent flow.")), []);
  useEffect(() => { load(); }, [load]);

  const steps = useMemo(() => (settings && config ? agentFlow({ settings, config, switches }) : []), [settings, config, switches]);
  const ladder = config?.parties?.agent?.followUp?.ladders?.outreach_nudge?.steps || [];
  // Each follow-up's text as the chart shows it: its own, or the spare it uses.
  const shownFollowUps = steps.filter((s) => s.edit?.field === "followUp").map((s) => s.texts[0]);

  const open = (id) => {
    const step = steps.find((s) => s.id === id);
    if (!step) { setEditing(id); setDraft({}); return; }
    const f = step.edit.field;
    if (f === "examples") {
      const o = normalizeOpener(settings?.outreachAutopilot?.opener);
      setDraft({ texts: [...step.texts], home: o.home, homes: homesText(o.homes) });
    }
    else if (f === "followUp") setDraft({ text: step.texts[0], day: step.day });
    else if (f === "pulse") setDraft({ enabled: settings?.outreachAutopilot?.pulse?.enabled === true, everyDays: Number(settings?.outreachAutopilot?.pulse?.everyDays) || 21 });
    else if (f === "checkIns") setDraft({ texts: [...step.texts], every: step.every });
    else if (f === "introEmail") setDraft({ ...normalizeIntroEmail(settings?.outreachAutopilot?.introEmail) });
    else if (f === "checkInEmail") setDraft({ ...normalizeCheckInEmail(settings?.outreachAutopilot?.checkInEmail) });
    setEditing(id);
  };
  const close = () => { setEditing(null); setDraft(null); };

  async function run(fn) {
    setBusy(true); setError("");
    try {
      await fn();
      const fresh = await getSettings();
      onSettingsSaved?.(fresh);
      setSetupVersion((v) => v + 1);
      await load();
      close();
    } catch (e) { setError(e.message || "Couldn't save."); }
    setBusy(false);
  }

  // The follow-up days live in the Conversation AI blob: read it fresh,
  // change only this ladder's days, write it back.
  async function saveDays(nextSteps) {
    const fresh = (await getConversationAi()).config;
    const fu = fresh.parties.agent.followUp;
    const ld = fu.ladders.outreach_nudge;
    await saveConversationAi({ ...fresh, parties: { ...fresh.parties, agent: { ...fresh.parties.agent,
      followUp: { ...fu, ladders: { ...fu.ladders, outreach_nudge: { ...ld, steps: nextSteps } } } } } });
  }
  const saveTexts = (followUps) => patchSettings({ outreachAutopilot: { opener: { followUps } } });
  // The check-in repeat after the last follow-up, the same way as the days.
  async function saveRepeat(repeatEvery) {
    const fresh = (await getConversationAi()).config;
    const fu = fresh.parties.agent.followUp;
    await saveConversationAi({ ...fresh, parties: { ...fresh.parties, agent: { ...fresh.parties.agent,
      followUp: { ...fu, ladders: { ...fu.ladders, outreach_nudge: { ...fu.ladders.outreach_nudge, repeatEvery } } } } } });
  }

  // Between the follow-up before and the one after, so the order (and which
  // text goes with which day) can't change by saving.
  const dayBounds = (i) => [i > 0 ? ladder[i - 1] + 1 : 1, i < ladder.length - 1 ? ladder[i + 1] - 1 : 90];

  function renderEditor(step) {
    const f = step.edit.field;
    if (f === "examples") {
      const texts = draft?.texts || [];
      const set = (i, v) => setDraft({ ...draft, texts: texts.map((t, j) => (j === i ? v : t)) });
      return (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">Each new agent gets one of these, a different one per agent. {HELP}</p>
          {texts.map((t, i) => (
            <TextBox key={i} label={`Version ${i + 1}`} value={t} onChange={(v) => set(i, v)}
              onRemove={texts.length > 1 ? () => setDraft({ ...draft, texts: texts.filter((_, j) => j !== i) }) : null} />
          ))}
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-semibold text-slate-600">Where we say we are ({"{home}"})</p>
            <p className="text-xs text-slate-500">
              One line per market: a county and its state, or a whole state, then the city. The listing's county decides; anywhere not listed gets the default.
            </p>
            <textarea className={AREA} rows={4} value={draft?.homes ?? ""} placeholder={"Deschutes, OR = Bend\nOR = Portland"}
              onChange={(e) => setDraft({ ...draft, homes: e.target.value })} />
            <label className="flex items-center gap-2 text-sm text-slate-700">
              Everywhere else
              <input className="w-40 rounded-lg border border-slate-300 px-2 py-1 text-sm" value={draft?.home ?? ""} placeholder="Seattle"
                onChange={(e) => setDraft({ ...draft, home: e.target.value })} />
            </label>
          </div>
          <EditorBar busy={busy} onCancel={close}
            onSave={() => run(() => patchSettings({ outreachAutopilot: { opener: { examples: texts.map((t) => t.trim()).filter(Boolean),
              home: String(draft?.home || "").trim(), homes: homesFrom(draft?.homes || "") } } }))}>
            {texts.length < OPENER_MAX_EXAMPLES && (
              <button type="button" className={BTN} onClick={() => setDraft({ ...draft, texts: [...texts, ""] })}><Plus size={12} aria-hidden="true" /> Add a version</button>
            )}
          </EditorBar>
        </div>
      );
    }
    if (f === "followUp") {
      const i = step.edit.index;
      const [lo, hi] = dayBounds(i);
      const day = Number(draft?.day);
      const dayOk = Number.isInteger(day) && day >= lo && day <= hi;
      return (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Send on day
            <input type="number" className={NUM} min={lo} max={hi} value={draft?.day ?? ""} onChange={(e) => setDraft({ ...draft, day: e.target.value })} />
            <span className="text-xs text-slate-500">after the first text, if they haven't replied ({lo}–{hi})</span>
          </label>
          <TextBox value={draft?.text || ""} onChange={(v) => setDraft({ ...draft, text: v })} />
          <p className="text-xs text-slate-500">{HELP}</p>
          <EditorBar busy={busy} onCancel={close}
            onSave={() => {
              if (!dayOk) { setError(`Follow-up ${i + 1} has to go out between day ${lo} and day ${hi}.`); return; }
              const texts = shownFollowUps.map((t, j) => (j === i ? draft.text.trim() : t));
              run(async () => { await saveTexts(texts); if (day !== ladder[i]) await saveDays(ladder.map((d, j) => (j === i ? day : d))); });
            }}>
            {ladder.length > 1 && (
              <button type="button" className={`${BTN_DANGER} ml-auto`} disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Remove follow-up ${i + 1}? Agents who haven't had it yet won't get it.`)) return;
                  run(async () => { await saveTexts(shownFollowUps.filter((_, j) => j !== i)); await saveDays(ladder.filter((_, j) => j !== i)); });
                }}>
                <Trash2 size={12} aria-hidden="true" /> Remove this follow-up
              </button>
            )}
          </EditorBar>
        </div>
      );
    }
    if (f === "checkIns") {
      const texts = draft?.texts || [];
      const set = (i, v) => setDraft({ ...draft, texts: texts.map((t, j) => (j === i ? v : t)) });
      const every = Number(draft?.every);
      const everyOk = Number.isInteger(every) && every >= 1 && every <= MAX_REPEAT_DAYS;
      return (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Every
            <input type="number" className={NUM} min={1} max={MAX_REPEAT_DAYS} value={draft?.every ?? ""} onChange={(e) => setDraft({ ...draft, every: e.target.value })} />
            <span className="text-xs text-slate-500">days after the last follow-up, until they reply</span>
          </label>
          <p className="text-xs text-slate-500">Each check-in is the next of these, in turn. {HELP}</p>
          {texts.map((t, i) => (
            <TextBox key={i} label={`Check-in ${i + 1}`} value={t} onChange={(v) => set(i, v)}
              onRemove={texts.length > 1 ? () => setDraft({ ...draft, texts: texts.filter((_, j) => j !== i) }) : null} />
          ))}
          <EditorBar busy={busy} onCancel={close}
            onSave={() => {
              if (!everyOk) { setError(`Check in every 1 to ${MAX_REPEAT_DAYS} days.`); return; }
              const clean = texts.map((t) => t.trim()).filter(Boolean);
              if (!clean.length) { setError("Write at least one check-in."); return; }
              run(async () => { await patchSettings({ outreachAutopilot: { opener: { checkIns: clean } } }); if (every !== step.every) await saveRepeat(every); });
            }}>
            {texts.length < OPENER_MAX_EXAMPLES && (
              <button type="button" className={BTN} onClick={() => setDraft({ ...draft, texts: [...texts, ""] })}><Plus size={12} aria-hidden="true" /> Add a check-in</button>
            )}
          </EditorBar>
        </div>
      );
    }
    if (f === "introEmail") {
      const day = Number(draft?.day);
      const dayOk = Number.isInteger(day) && day >= 1 && day <= 30;
      return (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={Boolean(draft?.enabled)} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Send the intro email
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={Boolean(draft?.autoSend)} onChange={(e) => setDraft({ ...draft, autoSend: e.target.checked })} />
            It sends itself
            <span className="text-xs text-slate-500">otherwise each one waits in the outbox for your Send</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Send on day
            <input type="number" className={NUM} min={1} max={30} value={draft?.day ?? ""} onChange={(e) => setDraft({ ...draft, day: e.target.value })} />
            <span className="text-xs text-slate-500">after the first text, if they haven't replied, and never within 3 days of another text of ours</span>
          </label>
          <label className="block space-y-1 text-sm text-slate-700">
            <span className="text-xs font-semibold text-slate-600">Subject</span>
            <input type="text" className={AREA} value={draft?.subject || ""} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </label>
          <label className="block space-y-1 text-sm text-slate-700">
            <span className="text-xs font-semibold text-slate-600">Email</span>
            <textarea className={AREA} rows={12} value={draft?.body || ""} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </label>
          <p className="whitespace-pre-wrap text-xs text-slate-500">Reads: {emailSampleOf(draft?.body || "") || "—"}</p>
          <p className="text-xs text-slate-500">{"{first}"} is their first name, {"{area}"} the town of their listing (or its county) "or the surrounding areas". A blank line starts a new paragraph.</p>
          <EditorBar busy={busy} onCancel={close}
            onSave={() => {
              if (!dayOk) { setError("The intro email goes out between day 1 and day 30."); return; }
              run(() => patchSettings({ outreachAutopilot: { introEmail: { enabled: Boolean(draft.enabled), autoSend: Boolean(draft.autoSend), day,
                subject: String(draft.subject || "").trim(), body: String(draft.body || "").trim() } } }));
            }} />
        </div>
      );
    }
    if (f === "checkInEmail") {
      const emails = draft?.emails || [];
      const set = (i, k, v) => setDraft({ ...draft, emails: emails.map((e, j) => (j === i ? { ...e, [k]: v } : e)) });
      return (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={Boolean(draft?.enabled)} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Send an email with each check-in
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={Boolean(draft?.autoSend)} onChange={(e) => setDraft({ ...draft, autoSend: e.target.checked })} />
            It sends itself
            <span className="text-xs text-slate-500">otherwise each one waits in the outbox for your Send</span>
          </label>
          <p className="text-xs text-slate-500">Each check-in sends the next of these. {"{first}"} is their first name, {"{area}"} the town of their listing (or its county) "or the surrounding areas". A blank line starts a new paragraph.</p>
          {emails.map((e, i) => (
            <div key={i} className="space-y-1 rounded-lg border border-slate-200 p-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-600">Email {i + 1}</span>
                {emails.length > 1 && (
                  <button type="button" className={`${BTN_DANGER} ml-auto`} onClick={() => setDraft({ ...draft, emails: emails.filter((_, j) => j !== i) })}>
                    <Trash2 size={12} aria-hidden="true" /> Remove
                  </button>
                )}
              </div>
              <input type="text" className={AREA} placeholder="Subject" value={e.subject} onChange={(ev) => set(i, "subject", ev.target.value)} />
              <textarea className={AREA} rows={7} value={e.body} onChange={(ev) => set(i, "body", ev.target.value)} />
              <p className="whitespace-pre-wrap text-xs text-slate-500">Reads: {emailSampleOf(e.body) || "—"}</p>
            </div>
          ))}
          <EditorBar busy={busy} onCancel={close}
            onSave={() => {
              const clean = emails.map((e) => ({ subject: String(e.subject || "").trim(), body: String(e.body || "").trim() })).filter((e) => e.subject && e.body);
              if (!clean.length) { setError("Write at least one email, with a subject."); return; }
              run(() => patchSettings({ outreachAutopilot: { checkInEmail: { enabled: Boolean(draft.enabled), autoSend: Boolean(draft.autoSend), emails: clean } } }));
            }}>
            {emails.length < CHECK_IN_EMAIL_MAX && (
              <button type="button" className={BTN} onClick={() => setDraft({ ...draft, emails: [...emails, { subject: "", body: "Hi {first},\n\n" }] })}><Plus size={12} aria-hidden="true" /> Add an email</button>
            )}
          </EditorBar>
        </div>
      );
    }
    if (f === "pulse") {
      return (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={Boolean(draft?.enabled)} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Write the day's check-ins
            <span className="text-xs text-slate-500">whether they send themselves is under Setup → Check in with every agent</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Every
            <input type="number" className={NUM} min={7} max={90} value={draft?.everyDays ?? ""} onChange={(e) => setDraft({ ...draft, everyDays: e.target.value })} />
            days to an agent who's talked to us
          </label>
          <EditorBar busy={busy} onCancel={close}
            onSave={() => run(() => patchSettings({ outreachAutopilot: { pulse: { enabled: Boolean(draft.enabled), everyDays: Number(draft.everyDays) } } }))} />
        </div>
      );
    }
    return null;
  }

  // A new follow-up after the last: a week on, with the next spare text.
  const last = ladder[ladder.length - 1] || 0;
  const firstIsApp = (settings?.outreachAutopilot?.firstTouch || "app") === "app";

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="mb-4">
          <h2 className="text-base font-bold text-slate-900">What goes out to agents</h2>
          <p className="text-sm text-slate-500">Shown for an agent named Brenda with a listing at 14820 SE 172nd St. Press Edit on a text to change it.</p>
        </div>
        {error && <div className="mb-3"><ErrorBar>{error}</ErrorBar></div>}
        {!settings || !config ? <SkeletonRows rows={4} cols={2} /> : (
          <>
            <FlowChart steps={steps} editing={editing} onEdit={open} renderEditor={renderEditor} />
            {firstIsApp && ladder.length < MAX_FOLLOW_UPS && last < 89 && (
              editing === "follow-new" ? (
                <div className="ml-11 mt-2 space-y-3 rounded-xl border border-blue-300 bg-white p-3 ring-2 ring-blue-100">
                  <div className="text-sm font-semibold text-slate-900">Follow-up {ladder.length + 1}</div>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    Send on day
                    <input type="number" className={NUM} min={last + 1} max={90} value={draft?.day ?? ""} onChange={(e) => setDraft({ ...draft, day: e.target.value })} />
                  </label>
                  <TextBox value={draft?.text || ""} onChange={(v) => setDraft({ ...draft, text: v })} />
                  <EditorBar busy={busy} onCancel={close}
                    onSave={() => {
                      const day = Number(draft?.day);
                      if (!Number.isInteger(day) || day <= last || day > 90) { setError(`The new follow-up has to go out after day ${last}, by day 90.`); return; }
                      if (!draft.text.trim()) { setError("Write the follow-up's text first."); return; }
                      run(async () => { await saveTexts([...shownFollowUps, draft.text.trim()]); await saveDays([...ladder, day]); });
                    }} />
                </div>
              ) : (
                <button type="button" className={`${BTN} ml-11 mt-1`}
                  onClick={() => { setEditing("follow-new"); setDraft({ day: last + 7, text: NUDGE_TEXTS[ladder.length % NUDGE_TEXTS.length] }); }}>
                  <Plus size={12} aria-hidden="true" /> Add a follow-up
                </button>
              )
            )}
          </>
        )}
      </section>

      <details className="rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          Agent list
          <span className="ml-2 font-normal text-slate-500">every agent we've found, the daily sweep, pulling listings</span>
        </summary>
        <div className="border-t border-slate-200 p-4"><AgentOutreach settings={appSettings} /></div>
      </details>

      <details className="rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          Setup
          <span className="ml-2 font-normal text-slate-500">RentCast key, the daily sweep, who sends the first text, check-in settings</span>
        </summary>
        <div className="border-t border-slate-200 p-4">
          <SettingsView key={setupVersion} settings={appSettings} onSaved={(s) => { onSettingsSaved?.(s); load(); }} mode="outreach" />
        </div>
      </details>
    </div>
  );
}
