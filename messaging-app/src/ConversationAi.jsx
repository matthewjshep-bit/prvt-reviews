// ConversationAi.jsx — the tab where the bot is tuned and watched.
//
// Top to bottom: the switches that matter most (on/off, the daily cap, whether
// the broker can send at all), how it has been doing, what is waiting right
// now, a place to try it, the editors, and the history that says which
// intents are ready to send on their own. Config edits are local until Save;
// the page owns only its own blob, and Settings never writes it.

import React, { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Power } from "lucide-react";
import { INTENT_LABEL, PARTY_LABEL, normalizeConversationAi, starterConfig } from "@shared/conversation-ai.js";
import { VERDICT_LABEL } from "@shared/graduation.js";
import { getConversationAi, getConversationHistory, getSettings, listOffers, listWorkflows, saveConversationAi, setConversationEnabled } from "./api.js";
import { autoAcceptCeiling } from "@shared/auto-accept.js";
import { fmtMoney } from "@shared/offer-calc.js";
import { BTN, BTN_PRIMARY, ErrorBar, FilterChips, KpiRow, Pill, SkeletonRows, TableCard } from "./ui.jsx";
import ReplyStrip from "./ReplyStrip.jsx";
import ConversationTryIt from "./ConversationTryIt.jsx";
import {
  AutoSendCard, CounterBandCard, ExamplesEditor, FollowUpCard, INPUT_CLS, MediaCard, OptOutCard, PartyPlaybooks,
  PersonaCard, ProfileCard, RequoteCard, RoutingCard, RulesEditor, Section, StyleCard,
} from "./ConversationPlaybooks.jsx";
import { IntentPill, PartyPill, ago } from "./ConversationOutbox.jsx";

export default function ConversationAi({ settings }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [version, setVersion] = useState(0);
  const [sendsEnabled, setSendsEnabled] = useState(true);
  const [seeded, setSeeded] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [workflows, setWorkflows] = useState({ list: [], loading: true, scopeMissing: false, error: "" });
  // The counter band's worked example. An operator shouldn't have to trust a
  // description of the ceiling — they should see it in dollars on a house they
  // recognise. Computed from the newest offer that has numbers on it, through
  // the same pure function the broker gates on.
  const [bandExample, setBandExample] = useState(null);
  const [history, setHistory] = useState(null);
  const [days, setDays] = useState(30);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toggling, setToggling] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    getConversationAi()
      .then((r) => { setConfig(r.config); setForm(r.config); setSendsEnabled(Boolean(r.sendsEnabled)); setSeeded(Boolean(r.seeded)); setVersion((v) => v + 1); })
      .catch((e) => setError(e.message));
    listWorkflows()
      .then((r) => setWorkflows({ list: r.workflows || [], loading: false, scopeMissing: Boolean(r.scopeMissing), error: r.error || "" }))
      .catch((e) => setWorkflows({ list: [], loading: false, scopeMissing: false, error: e.message }));
    Promise.all([listOffers({ limit: 25, lean: true }), getSettings()])
      .then(([offers, settings]) => {
        // listOffers and getSettings both unwrap their envelope already.
        const offer = (offers || []).find((x) => x.arv > 0 && x.repairs > 0 && x.cashAmount > 0);
        if (!offer) return setBandExample(null);
        const c = autoAcceptCeiling({ offer, settings: settings || {} });
        setBandExample({ ...c, address: offer.address,
          oursText: fmtMoney(offer.cashAmount), ceilingText: fmtMoney(c.ceiling) });
      })
      .catch(() => setBandExample(null));
  }, []);

  useEffect(() => {
    getConversationHistory(days).then(setHistory).catch(() => setHistory({ drafts: [], stats: { byParty: {}, totals: {} } }));
  }, [days, refreshKey]);

  const dirty = useMemo(() => form && config && JSON.stringify(normalizeConversationAi(form)) !== JSON.stringify(config), [form, config]);
  const patch = (partial) => { setSaved(false); setForm((f) => ({ ...f, ...partial })); };

  // On and off take effect the moment they're clicked — no Save, because the
  // moment you reach for this is the moment you don't want to think. Off also
  // holds every reply already counting down to send itself.
  async function setEnabled(next) {
    if (!next && !window.confirm("Turn the Conversation AI off?\n\nNo new drafts are written, and anything counting down to send itself is held for you.")) return;
    setToggling(true); setError(""); setNotice("");
    try {
      const r = await setConversationEnabled(next);
      setConfig(r.config);
      setForm((f) => ({ ...f, enabled: r.config.enabled }));
      setNotice(next
        ? "Conversation AI is back on."
        : `Conversation AI is off.${r.held ? ` ${r.held} repl${r.held === 1 ? "y that was" : "ies that were"} counting down ${r.held === 1 ? "was" : "were"} held.` : ""}`);
    } catch (e) { setError(e.message); }
    setToggling(false);
  }

  async function save() {
    setSaving(true); setError("");
    try {
      const next = await saveConversationAi(form);
      setConfig(next); setForm(next); setSeeded(false); setVersion((v) => v + 1); setSaved(true);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  // Promote: tick one intent on its party's allowlist. Saves on the spot when
  // nothing else is pending, so the click is the decision; with other edits
  // open it only ticks, and the Save button carries them all together.
  async function promote(party, intent) {
    const pb = form.parties[party];
    const label = INTENT_LABEL[party]?.[intent] || intent;
    if (!window.confirm(`Let "${label}" replies to ${PARTY_LABEL[party].toLowerCase()}s send themselves?\n\nEvery other gate still applies: quiet hours, the delay, the money guard, the daily cap.`)) return;
    const next = { ...form, parties: { ...form.parties, [party]: { ...pb, autoSend: { enabled: true, intents: [...new Set([...(pb.autoSend?.intents || []), intent])] } } } };
    if (dirty) { patch(next); setNotice(`"${label}" is ticked — press Save to keep it with your other changes.`); return; }
    setSaving(true); setError("");
    try {
      const savedConfig = await saveConversationAi(next);
      setConfig(savedConfig); setForm(savedConfig); setSaved(true);
      setNotice(`"${label}" replies to ${PARTY_LABEL[party].toLowerCase()}s now send themselves.`);
      setRefreshKey((k) => k + 1);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  if (error && !form) return <ErrorBar>{error}</ErrorBar>;
  if (!form) return <SkeletonRows cols={4} rows={4} />;

  const t = history?.stats?.totals || {};
  const kpis = [
    { label: `Drafts · ${days}d`, value: t.total ?? "—" },
    { label: "Sent itself", value: t.autoSent ?? "—", hint: "Replies that went out with nobody reading them" },
    { label: "Sent as written", value: t.sent ? `${Math.round(((t.sentUnedited || 0) / t.sent) * 100)}%` : "—", hint: "Of the replies a person sent, how many they didn't edit" },
    { label: "Waiting on you", value: t.pending ?? "—" },
    { label: "Ready to promote", value: history?.graduation ? history.graduation.ready : "—", hint: "Intents a person has sent as written often enough to send themselves" },
  ];

  return (
    <div className="space-y-4">
      {!form.enabled && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3">
          <Power size={16} className="shrink-0 text-red-700" />
          <span className="text-sm font-bold text-red-800">Conversation AI is off</span>
          <span className="text-xs text-red-700">
            Nothing is being drafted and nothing can send itself. Inbound texts are waiting on you until it's back on.
          </span>
          <button type="button" disabled={toggling} onClick={() => setEnabled(true)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-40">
            {toggling ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />} Turn it back on
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <button type="button" disabled={toggling} onClick={() => setEnabled(!form.enabled)}
          title={form.enabled ? "Stop it drafting, and hold anything counting down to send" : "Start drafting again"}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors disabled:opacity-40 ${
            form.enabled
              ? "border border-red-300 bg-white text-red-700 hover:bg-red-50"
              : "bg-emerald-600 text-white hover:bg-emerald-700"}`}>
          {toggling ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
          {form.enabled ? "Turn off" : "Turn on"}
        </button>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <span className={`h-2 w-2 rounded-full ${form.enabled ? "bg-emerald-500" : "bg-red-500"}`} aria-hidden="true" />
          {form.enabled ? "On" : "Off"}
        </span>
        {/* 0 on either box means no cap. The caps are there to bound a
            runaway loop, not to ration a busy day — a blast to a big buyer
            list is a real day's traffic. */}
        <label className="flex items-center gap-2 text-sm text-slate-600" title="0 means no cap">
          Daily cap
          <input type="number" min="0" className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm" value={form.dailyCap}
            onChange={(e) => patch({ dailyCap: Number(e.target.value) })} />
          drafts, and
          <input type="number" min="0" className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm" value={form.dailyCapPerContact}
            onChange={(e) => patch({ dailyCapPerContact: Number(e.target.value) })} />
          per contact
          <span className="text-xs text-slate-400">
            {form.dailyCap === 0 && form.dailyCapPerContact === 0 ? "no caps" : "0 = no cap"}
          </span>
        </label>
        {!sendsEnabled && (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800" title="Set CARD_SENDS_ENABLED=true on the broker">
            Sends are off on the broker — nothing can go out, by you or by itself
          </span>
        )}
        {seeded && <span className="text-xs text-slate-500">Carried over from the old Reply agent settings — save once to keep it.</span>}
        {workflows.scopeMissing && (
          <span className="text-xs text-amber-700" title={workflows.error}>
            Add the workflows.readonly scope to your Private Integration so the starter can wire your TIER workflows by name.
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BTN}
            title="Replace the persona, rules, examples, routing, texting rules, opt-outs and both playbooks with the Shep Flips starter (your three GHL bots, consolidated). The on/off switch, the cap and the auto-send timing stay as they are; every auto-send stays off until you tick it."
            onClick={() => {
              if (!window.confirm("Load the Shep Flips starter playbook? It replaces the persona, rules, examples, routing, texting rules, opt-outs and both playbooks. Nothing is saved until you press Save.")) return;
              const st = starterConfig({
                signer: settings?.company?.signer || settings?.company?.name || "",
                company: settings?.company?.name || "Shep Flips",
                workflows: workflows.list,   // TIER 1/2/3 and Tier 1/2 Disposition are wired by name when the list is visible
              });
              patch({ ...st, enabled: form.enabled, dailyCap: form.dailyCap, dailyCapPerContact: form.dailyCapPerContact,
                autoSend: { ...st.autoSend, delayMinSec: form.autoSend.delayMinSec, delayMaxSec: form.autoSend.delayMaxSec, quietHours: form.autoSend.quietHours, channels: form.autoSend.channels } });
            }}>
            Load starter playbook
          </button>
          {saved && !dirty && <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check size={13} /> Saved</span>}
          {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
          <button type="button" className={BTN_PRIMARY} disabled={saving || (!dirty && !seeded)} onClick={save}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save
          </button>
        </div>
      </div>
      {error && <ErrorBar>{error}</ErrorBar>}
      {notice && <div className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{notice}</div>}

      <KpiRow cols="sm:grid-cols-5" items={kpis} />

      <ReplyStrip title="Waiting on you" emptyText="Nothing waiting — every inbound text has been answered or is being drafted." refreshKey={refreshKey} />

      <ConversationTryIt sendsEnabled={sendsEnabled} />

      <PersonaCard config={form} patch={patch} />
      <RoutingCard config={form} patch={patch} version={version} />
      <PartyPlaybooks config={form} patch={patch} workflows={workflows} />
      <FollowUpCard config={form} patch={patch} />
      <AutoSendCard config={form} patch={patch} />
      <CounterBandCard config={form} patch={patch} example={bandExample} />
      <RequoteCard config={form} patch={patch} />
      <ProfileCard config={form} patch={patch} />
      <StyleCard config={form} patch={patch} />
      <OptOutCard config={form} patch={patch} version={version} workflows={workflows} />
      <MediaCard config={form} patch={patch} />
      <RulesEditor config={form} patch={patch} />
      <ExamplesEditor config={form} patch={patch} />

      <HistorySection history={history} days={days} setDays={setDays} onRefresh={() => setRefreshKey((k) => k + 1)} onPromote={promote} saving={saving} />
    </div>
  );
}

/* ---------- history + graduation stats ---------- */

const VERDICT_STYLE = {
  on: "bg-emerald-100 text-emerald-800",
  ready: "bg-blue-600 text-white",
  not_yet: "bg-amber-100 text-amber-800",
  not_enough: "bg-slate-100 text-slate-500",
  locked: "bg-slate-100 text-slate-400",
};

const outcomeOf = (d) => {
  if (d.status === "sent") return d.autoSent ? ["sent itself", "text-emerald-700"] : d.edited ? ["sent, edited", "text-slate-700"] : ["sent as written", "text-emerald-700"];
  if (d.status === "dismissed") return d.answeredBy === "you" ? ["you answered it", "text-slate-500"] : ["dismissed", "text-slate-500"];
  if (d.status === "superseded") return ["superseded", "text-slate-400"];
  if (d.status === "handled") return [d.intent === "opt_out" ? "opted out, no reply" : "handled", "text-slate-500"];
  if (d.status === "scheduled") return ["sending soon", "text-amber-700"];
  if (d.status === "sending") return ["sending", "text-amber-700"];
  return [d.heldAt ? "held, waiting" : "waiting", "text-amber-700"];
};

function HistorySection({ history, days, setDays, onRefresh, onPromote, saving }) {
  const [party, setParty] = useState("all");
  if (!history) return <Section title="History"><SkeletonRows cols={5} rows={3} /></Section>;
  const rows = (history.drafts || []).filter((d) => party === "all" || (d.party || "agent") === party);
  const byParty = history.stats?.byParty || {};
  const graduation = history.graduation;
  return (
    <Section title="History"
      intro={`Every draft in the window, and per intent, how often a person sent the AI's draft as written. An intent is ready to send itself once you've sent ${graduation?.rule?.minAsWrittenPct ?? 90}% of at least ${graduation?.rule?.minVerdicts ?? 20} of them untouched — press Promote and it goes on the allowlist.`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterChips value={party} onChange={setParty} label="Party"
          options={[["all", "All"], ["agent", "Agents"], ["investor", "Investors"], ["unknown", "Unknown"]].map(([key, label]) => ({ key, label, count: key === "all" ? history.drafts?.length : (byParty[key]?.total || 0) }))} />
        <select className={`${INPUT_CLS} ml-auto w-auto`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
      </div>

      {graduation && (
        <div className="mb-4 grid gap-3 lg:grid-cols-2">
          {Object.entries(graduation.byParty).filter(([p]) => party === "all" || p === party).map(([p, verdicts]) => (
            <TableCard key={p}>
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">{PARTY_LABEL[p] || p}s · intent</th>
                    <th className="px-2 py-2 text-right">drafts</th>
                    <th className="px-2 py-2 text-right" title="A person sent the AI's draft without editing it">as written</th>
                    <th className="px-2 py-2 text-right">edited</th>
                    <th className="px-2 py-2 text-right">dismissed</th>
                    <th className="px-2 py-2 text-right">sent itself</th>
                    <th className="px-2 py-2" title={`${graduation.rule.minAsWrittenPct}% as written over at least ${graduation.rule.minVerdicts} of your verdicts`}>verdict</th>
                    <th className="px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {verdicts.filter((v) => v.verdicts > 0 || v.state === "ready" || v.state === "on" || (byParty[p]?.byIntent?.[v.intent]?.total || 0) > 0).map((v) => {
                    const c = byParty[p]?.byIntent?.[v.intent] || {};
                    const st = VERDICT_STYLE[v.state] || VERDICT_STYLE.not_enough;
                    return (
                      <tr key={v.intent} className="border-t border-slate-100">
                        <td className="px-3 py-1.5">{v.label}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.total || 0}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-emerald-700">{v.asWritten}{v.pct != null && <span className="ml-1 font-normal text-slate-400">{v.pct}%</span>}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.sentEdited || 0}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.dismissed || 0}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.autoSent || 0}</td>
                        <td className="px-2 py-1.5">
                          <Pill small label={VERDICT_LABEL[v.state]} cls={st}
                            title={v.state === "not_enough" ? `${v.needed} more verdict${v.needed === 1 ? "" : "s"} needed` : v.state === "not_yet" ? `${v.pct}% as written, needs ${graduation.rule.minAsWrittenPct}%` : ""} />
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {v.state === "ready" && onPromote && (
                            <button type="button" className={BTN_PRIMARY + " !px-2.5 !py-1 !text-xs"} disabled={saving} onClick={() => onPromote(p, v.intent)}>Promote</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableCard>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">No drafts in this window.</div>
      ) : (
        <TableCard>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Contact</th><th className="px-3 py-2">Intent</th><th className="px-3 py-2">They said</th><th className="px-3 py-2">Outcome</th><th className="px-3 py-2">Actions</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((d) => {
                const [label, cls] = outcomeOf(d);
                const acts = (d.actions || []).filter((a) => a.status === "done" || a.status === "applied");
                return (
                  <tr key={d.id} className="border-t border-slate-100 align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500" title={d.createdAt}>{ago(d.createdAt)}</td>
                    <td className="px-3 py-2"><div className="font-medium">{d.contactName || "—"}</div><PartyPill party={d.party} /></td>
                    <td className="px-3 py-2"><IntentPill party={d.party} intent={d.intent} /></td>
                    <td className="max-w-md px-3 py-2 text-xs text-slate-600" title={d.reply}>“{d.inbound}”</td>
                    <td className={`whitespace-nowrap px-3 py-2 text-xs ${cls}`}>{label}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{acts.map((a) => a.detail || a.type).join(", ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableCard>
      )}
      <button type="button" className="mt-2 text-xs text-slate-400 hover:text-slate-700" onClick={onRefresh}>Refresh</button>
    </Section>
  );
}
