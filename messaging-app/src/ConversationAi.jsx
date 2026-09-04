// ConversationAi.jsx — the tab where the bot is tuned and watched.
//
// Top to bottom: the switches that matter most (on/off, the daily cap, whether
// the broker can send at all), how it has been doing, what is waiting right
// now, a place to try it, the editors, and the history that says which
// intents are ready to send on their own. Config edits are local until Save;
// the page owns only its own blob, and Settings never writes it.

import React, { useEffect, useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { INTENT_LABEL, PARTY_LABEL, normalizeConversationAi, starterConfig } from "@shared/conversation-ai.js";
import { getConversationAi, getConversationHistory, listWorkflows, saveConversationAi } from "./api.js";
import { BTN, BTN_PRIMARY, ErrorBar, FilterChips, KpiRow, SkeletonRows, TableCard } from "./ui.jsx";
import ReplyStrip from "./ReplyStrip.jsx";
import ConversationTryIt from "./ConversationTryIt.jsx";
import {
  AutoSendCard, ExamplesEditor, INPUT_CLS, MediaCard, OptOutCard, PartyPlaybooks, PersonaCard, ProfileCard, RoutingCard,
  RulesEditor, Section, StyleCard,
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
  const [history, setHistory] = useState(null);
  const [days, setDays] = useState(30);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    getConversationAi()
      .then((r) => { setConfig(r.config); setForm(r.config); setSendsEnabled(Boolean(r.sendsEnabled)); setSeeded(Boolean(r.seeded)); setVersion((v) => v + 1); })
      .catch((e) => setError(e.message));
    listWorkflows()
      .then((r) => setWorkflows({ list: r.workflows || [], loading: false, scopeMissing: Boolean(r.scopeMissing), error: r.error || "" }))
      .catch((e) => setWorkflows({ list: [], loading: false, scopeMissing: false, error: e.message }));
  }, []);

  useEffect(() => {
    getConversationHistory(days).then(setHistory).catch(() => setHistory({ drafts: [], stats: { byParty: {}, totals: {} } }));
  }, [days, refreshKey]);

  const dirty = useMemo(() => form && config && JSON.stringify(normalizeConversationAi(form)) !== JSON.stringify(config), [form, config]);
  const patch = (partial) => { setSaved(false); setForm((f) => ({ ...f, ...partial })); };

  async function save() {
    setSaving(true); setError("");
    try {
      const next = await saveConversationAi(form);
      setConfig(next); setForm(next); setSeeded(false); setVersion((v) => v + 1); setSaved(true);
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
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <input type="checkbox" checked={form.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          Conversation AI is {form.enabled ? "on" : "off"}
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Daily cap
          <input type="number" min="1" className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm" value={form.dailyCap}
            onChange={(e) => patch({ dailyCap: Number(e.target.value) })} />
          drafts, and
          <input type="number" min="1" className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm" value={form.dailyCapPerContact}
            onChange={(e) => patch({ dailyCapPerContact: Number(e.target.value) })} />
          per contact
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

      <KpiRow items={kpis} />

      <ReplyStrip title="Waiting on you" emptyText="Nothing waiting — every inbound text has been answered or is being drafted." refreshKey={refreshKey} />

      <ConversationTryIt sendsEnabled={sendsEnabled} />

      <PersonaCard config={form} patch={patch} />
      <RoutingCard config={form} patch={patch} version={version} />
      <PartyPlaybooks config={form} patch={patch} workflows={workflows} />
      <AutoSendCard config={form} patch={patch} />
      <ProfileCard config={form} patch={patch} />
      <StyleCard config={form} patch={patch} />
      <OptOutCard config={form} patch={patch} version={version} workflows={workflows} />
      <MediaCard config={form} patch={patch} />
      <RulesEditor config={form} patch={patch} />
      <ExamplesEditor config={form} patch={patch} />

      <HistorySection history={history} days={days} setDays={setDays} onRefresh={() => setRefreshKey((k) => k + 1)} />
    </div>
  );
}

/* ---------- history + graduation stats ---------- */

const outcomeOf = (d) => {
  if (d.status === "sent") return d.autoSent ? ["sent itself", "text-emerald-700"] : d.edited ? ["sent, edited", "text-slate-700"] : ["sent as written", "text-emerald-700"];
  if (d.status === "dismissed") return ["dismissed", "text-slate-500"];
  if (d.status === "superseded") return ["superseded", "text-slate-400"];
  if (d.status === "handled") return [d.intent === "opt_out" ? "opted out, no reply" : "handled", "text-slate-500"];
  if (d.status === "scheduled") return ["sending soon", "text-amber-700"];
  if (d.status === "sending") return ["sending", "text-amber-700"];
  return [d.heldAt ? "held, waiting" : "waiting", "text-amber-700"];
};

function HistorySection({ history, days, setDays, onRefresh }) {
  const [party, setParty] = useState("all");
  if (!history) return <Section title="History"><SkeletonRows cols={5} rows={3} /></Section>;
  const rows = (history.drafts || []).filter((d) => party === "all" || (d.party || "agent") === party);
  const byParty = history.stats?.byParty || {};
  return (
    <Section title="History"
      intro="Every draft in the window, and per intent, how often a person sent the AI's draft as written. When 'sent as written' matches 'auto-sendable' for a few weeks, that intent is ready to send itself.">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterChips value={party} onChange={setParty} label="Party"
          options={[["all", "All"], ["agent", "Agents"], ["investor", "Investors"], ["unknown", "Unknown"]].map(([key, label]) => ({ key, label, count: key === "all" ? history.drafts?.length : (byParty[key]?.total || 0) }))} />
        <select className={`${INPUT_CLS} ml-auto w-auto`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
      </div>

      {Object.keys(byParty).length > 0 && (
        <div className="mb-4 grid gap-3 lg:grid-cols-2">
          {Object.entries(byParty).filter(([p]) => party === "all" || p === party).map(([p, s]) => (
            <TableCard key={p}>
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-2">{PARTY_LABEL[p] || p}s · intent</th><th className="px-2 py-2 text-right">drafts</th><th className="px-2 py-2 text-right" title="The gates would have let it go">auto-sendable</th><th className="px-2 py-2 text-right" title="A person sent the AI's draft without editing it">sent as written</th><th className="px-2 py-2 text-right">sent itself</th><th className="px-2 py-2 text-right">edited</th><th className="px-2 py-2 text-right">dismissed</th></tr>
                </thead>
                <tbody>
                  {Object.entries(s.byIntent).sort((a, b) => b[1].total - a[1].total).map(([intent, c]) => (
                    <tr key={intent} className="border-t border-slate-100">
                      <td className="px-3 py-1.5">{INTENT_LABEL[p]?.[intent] || intent}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.total}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.autoSendable}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-emerald-700">{c.humanSentUnedited}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.autoSent}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.sentEdited}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.dismissed}</td>
                    </tr>
                  ))}
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
