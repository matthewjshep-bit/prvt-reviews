// LotsTab.jsx — Autopilot → Lots (2026-11-23): the luxury teardown lane's
// front end. A pocket is a circle around an address; the finder pulls the
// old houses on big lots in it, looks up the owners' cell numbers, puts them
// in GHL tagged apart from agents, and texts each one once with the price
// band, then a follow-up a day later. A reply is yours: the bot never
// answers a homeowner, and the Desk says call now.
//
// Everything ships off. Texts send themselves only when "Texts send
// themselves" is on here AND the broker has CARD_SENDS_ENABLED and
// OWNER_SMS_ENABLED. Imports are dry until OUTREACH_IMPORTS_ENABLED.

import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { normalizeLotFinder, normalizePocket, OWNER_STATUSES, OWNER_PLAYBOOK, BUILDER_PLAYBOOK } from "@shared/lot-finder.js";
import { getLotFinder, getLotOwners, getLotBuilders, setLotOwnerStatus, suggestLotPocket, runLotFinder, patchSettings } from "./api.js";
import { BTN, BTN_PRIMARY, ErrorBar, Pill } from "./ui.jsx";

const INPUT = "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";
const STATUS_LABEL = { new: "Found", tracing: "Tracing", traced: "Has a cell", no_phone: "No cell", imported: "In GHL", skipped: "Skipped", do_not_contact: "Do not contact" };
const money = (n) => (n > 0 ? (n >= 1000000 ? `$${(n / 1000000).toFixed(2).replace(/\.?0+$/, "")}M` : `$${Math.round(n / 1000)}k`) : "—");

function PocketCard({ p, onChange, onRemove, counts, canSuggest }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const set = (patch) => onChange({ ...p, ...patch });
  const suggest = async () => {
    setBusy(true); setErr(""); setNote("");
    try {
      const r = await suggestLotPocket(p.address, p.radiusMiles);
      const s = r.suggest || {};
      set({ lat: r.center?.lat || p.lat, lng: r.center?.lng || p.lng,
        ...(s.yearBuiltMax ? { yearBuiltMax: s.yearBuiltMax } : {}), ...(s.lotSqftMin ? { lotSqftMin: s.lotSqftMin } : {}),
        ...(s.bandLo ? { bandLo: s.bandLo } : {}), ...(s.bandHi ? { bandHi: s.bandHi } : {}) });
      setNote(`${s.exits || 0} new build${s.exits === 1 ? "" : "s"} sold nearby${s.exitLo ? ` (${money(s.exitLo)}–${money(s.exitHi)})` : ""}; ${s.teardowns || 0} teardown${s.teardowns === 1 ? "" : "s"} sold in the lot band${s.lotValue ? `, lot value about ${money(s.lotValue)}` : ""}. Check the numbers before you turn it on.`);
    } catch (e) { setErr(e.message || "Couldn't read Zillow for that address."); } finally { setBusy(false); }
  };
  const c = counts || {};
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <input className={`${INPUT} max-w-xs font-semibold`} value={p.name} placeholder="Pocket name" aria-label="Pocket name" onChange={(e) => set({ name: e.target.value })} />
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-slate-700"><input type="checkbox" checked={p.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> On</label>
          <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600" aria-label="Remove pocket" onClick={onRemove}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_6rem_auto]">
        <label className="text-xs font-semibold text-slate-600">Center address
          <input className={INPUT} value={p.address} placeholder="An address in the middle of the pocket" onChange={(e) => set({ address: e.target.value })} />
        </label>
        <label className="text-xs font-semibold text-slate-600">Radius, mi
          <input type="number" step="0.25" min="0.25" max="5" className={INPUT} value={p.radiusMiles} onChange={(e) => set({ radiusMiles: Number(e.target.value) })} />
        </label>
        <button type="button" className={`${BTN} self-end`} disabled={busy || !canSuggest || !p.address.trim()} onClick={suggest}
          title={canSuggest ? "Two Zillow searches: the new builds that sold nearby, and the old houses that sold in the same lot band" : "Needs the Apify token in Settings"}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Suggest from Zillow
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <label className="text-xs font-semibold text-slate-600">Lot at least, sqft<input type="number" className={INPUT} value={p.lotSqftMin} onChange={(e) => set({ lotSqftMin: Number(e.target.value) })} /></label>
        <label className="text-xs font-semibold text-slate-600">Built before<input type="number" className={INPUT} value={p.yearBuiltMax} onChange={(e) => set({ yearBuiltMax: Number(e.target.value) })} /></label>
        <label className="text-xs font-semibold text-slate-600">Owned, years<input type="number" className={INPUT} value={p.yearsOwnedMin} onChange={(e) => set({ yearsOwnedMin: Number(e.target.value) })} /></label>
        <label className="text-xs font-semibold text-slate-600">Price band from, $<input type="number" className={INPUT} value={p.bandLo} onChange={(e) => set({ bandLo: Number(e.target.value) })} /></label>
        <label className="text-xs font-semibold text-slate-600">to, $<input type="number" className={INPUT} value={p.bandHi} onChange={(e) => set({ bandHi: Number(e.target.value) })} /></label>
      </div>
      <p className="text-xs text-slate-500">
        {p.lat && p.lng ? "On the map. " : "Not on the map yet: press Suggest, or save and the first run places it. "}
        {p.bandLo > 0 ? `Comps for the reply: ${money(p.bandLo)} to ${money(p.bandHi)}. The first text names the neighborhood, not a number.` : "No price band yet: the first text still goes (it names the neighborhood, not a number); the bot has no comps to quote until Suggest sets one."}
        {c.total ? ` · ${c.total} found, ${c.traced || 0} with a cell, ${c.imported || 0} in GHL, ${c.no_phone || 0} no cell.` : ""}
      </p>
      {note && <p className="text-xs text-blue-800" role="status">{note}</p>}
      {err && <ErrorBar>{err}</ErrorBar>}
    </div>
  );
}

export default function LotsTab() {
  const [f, setF] = useState(null);
  const [info, setInfo] = useState(null);
  const [owners, setOwners] = useState([]);
  const [builders, setBuilders] = useState([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(() => Promise.all([getLotFinder(), getLotOwners({ limit: 300 }).catch(() => ({ owners: [] })), getLotBuilders({ limit: 200 }).catch(() => ({ builders: [] }))])
    .then(([r, o, b]) => { setInfo(r); setF(normalizeLotFinder(r.settings)); setOwners(o.owners || []); setBuilders(b.builders || []); setErr(""); })
    .catch((e) => setErr(e.message || "Couldn't load the lot finder.")), []);
  useEffect(() => { load(); }, [load]);
  if (!f) return err ? <ErrorBar>{err}</ErrorBar> : <p className="p-4 text-sm text-slate-500">Loading…</p>;

  const set = (patch) => setF({ ...f, ...patch });
  const check = (key, label, hint) => (
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" className="mt-1" checked={Boolean(f[key])} onChange={(e) => set({ [key]: e.target.checked })} />
      <span>{label}{hint && <span className="block text-xs text-slate-500">{hint}</span>}</span>
    </label>
  );
  const num = (key, label, min, max) => (
    <label className="text-xs font-semibold text-slate-600">{label}
      <input type="number" min={min} max={max} className={INPUT} value={f[key]} onChange={(e) => set({ [key]: Number(e.target.value) })} />
    </label>
  );
  const save = async () => {
    setBusy("save"); setMsg(""); setErr("");
    try {
      const r = await patchSettings({ lotFinder: normalizeLotFinder(f) });
      setF(normalizeLotFinder(r.settings?.lotFinder));
      setMsg("Saved.");
    } catch (e) { setErr(e.message || "Not saved."); } finally { setBusy(""); }
  };
  const run = async (dryRun) => {
    setBusy("run"); setMsg(""); setErr("");
    try {
      const r = await runLotFinder({ dryRun });
      const j = r.job || {};
      if (j.error) throw new Error(j.error);
      const parcels = (j.pockets || []).map((p) => `${p.id}: ${p.parcels ?? "?"} parcel${p.parcels === 1 ? "" : "s"}${p.skipped ? ` (${p.skipped})` : ""}${p.error ? ` (${p.error})` : ""}`).join("; ");
      setMsg(dryRun
        ? `Dry run — ${parcels || "no pockets"}. Would trace ${j.traced?.would || 0}, would import ${j.imported?.would || 0}, would text ${j.texts?.would || 0}.`
        : `Ran — ${parcels}. Traced ${j.traced?.looked || 0} (${j.traced?.reachable || 0} with a cell${j.traced?.credits ? `, ${j.traced.credits} credits` : ""}${j.traced?.stopped ? `; ${j.traced.stopped}` : ""}); owners imported ${j.imported?.created || 0}${j.imported?.dry ? ` (dry: ${j.imported.would} would)` : ""}; builders imported ${j.builders?.created || 0}${j.builders?.would ? ` (dry: ${j.builders.would} would)` : ""}; texts ${j.texts?.scheduled || 0} scheduled, ${j.texts?.drafted || 0} waiting for you.`);
      await load();
    } catch (e) { setErr(e.message || "The run failed."); } finally { setBusy(""); }
  };
  const mark = async (ownerKey, status) => {
    try { await setLotOwnerStatus(ownerKey, status); await load(); } catch (e) { setErr(e.message); }
  };
  const sw = info?.switches || {};
  const last = info?.last;
  const state = !f.enabled ? "off" : f.dryRun ? "on, dry run" : f.autoSend && sw.ownerSms && sw.sends ? "on, texts send themselves" : "on, texts wait for you";

  return (
    <div className="space-y-4 p-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-800">Lots: {state}</h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN} disabled={Boolean(busy)} onClick={() => run(true)}>{busy === "run" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Dry run now</button>
            <button type="button" className={BTN} disabled={Boolean(busy) || f.dryRun || !f.enabled} title={f.dryRun ? "Turn off Dry run and save first" : "Pulls, traces and imports now, as the settings allow"} onClick={() => run(false)}>Run now</button>
            <button type="button" className={BTN_PRIMARY} disabled={Boolean(busy)} onClick={save}>{busy === "save" ? "Saving…" : "Save"}</button>
          </div>
        </div>
        <p className="max-w-3xl text-xs text-slate-600">
          Each weekday at 10am: pull the old houses on big lots in each pocket (weekly), look up the owners' cell numbers up to the day's cap, put the day's new ones in GHL tagged <code>lot-owner</code>, and write each a first text that names the price band, then one follow-up a day later. A reply is yours: the bot never answers a homeowner, and the Desk says call now. The same weekly pass reads the new builds that sold in the pocket and finds the builders behind them, by their own number: the contractor registry by name, the county's sale record for the company, a skip trace for a one-off LLC. Only the builder goes into the buyer book, never the listing agent.
        </p>
        {err && <ErrorBar>{err}</ErrorBar>}
        {msg && <p className="mt-2 text-sm text-blue-800" role="status">{msg}</p>}
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {check("enabled", "On", "Runs each weekday morning.")}
          {check("dryRun", "Dry run", "Counts the parcels and says who it would trace and text. Spends and writes nothing.")}
          {check("autoSend", "Texts send themselves", `Off: every text waits in the outbox for your Send.${sw.ownerSms ? "" : " The broker also needs OWNER_SMS_ENABLED before any owner text goes on its own."}`)}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <label className="text-xs font-semibold text-slate-600">When an owner writes back
            <select className={INPUT} value={f.bot} onChange={(e) => set({ bot: e.target.value })}>
              <option value="draft">The bot drafts the reply, you send it</option>
              <option value="send">The bot answers on its own (agent auto-send rules apply)</option>
              <option value="off">No draft: the thread is yours</option>
            </select>
          </label>
        </div>
        <details className="mt-3 rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">How the bot talks to owners and builders</summary>
          <p className="mt-2 text-xs text-slate-500">The bot already knows the method: no condition questions, the price band and the eight percent openly, privacy and certainty, a couple of months after closing; to a builder, the lot and the envelope, never ARV or rehab. Add your own words here and they ride along with it.</p>
          <label className="mt-2 block text-xs font-semibold text-slate-600">Your words for owners (blank = the default below)
            <textarea className={INPUT} rows={4} value={f.ownerPlaybook} placeholder={OWNER_PLAYBOOK.slice(0, 220) + "…"} onChange={(e) => set({ ownerPlaybook: e.target.value })} />
          </label>
          <label className="mt-2 block text-xs font-semibold text-slate-600">Your words for builders (blank = the default below)
            <textarea className={INPUT} rows={3} value={f.builderPlaybook} placeholder={BUILDER_PLAYBOOK.slice(0, 220) + "…"} onChange={(e) => set({ builderPlaybook: e.target.value })} />
          </label>
        </details>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {num("dailyNew", "Owners texted per day", 0, 200)}
          {num("traceDailyCap", "Skip-trace lookups per day (about 10¢ each)", 0, 500)}
          {num("followUpDays", "Follow-up, days after the first text", 0, 14)}
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Pill tone={sw.propertyKey ? "ok" : "warn"}>{sw.propertyKey ? "Property data key set" : "No property-data key (Settings → comps API)"}</Pill>
          <Pill tone={sw.traceKey ? "ok" : "warn"}>{sw.traceKey ? "Skip-trace key set" : "No skip-trace key (TRACERFY_API_KEY)"}</Pill>
          <Pill tone={sw.imports ? "ok" : "muted"}>{sw.imports ? "Imports live" : "Imports dry (OUTREACH_IMPORTS_ENABLED)"}</Pill>
          <Pill tone={sw.ownerSms && sw.sends ? "ok" : "muted"}>{sw.ownerSms && sw.sends ? "Owner texts may send" : "Owner texts wait for you (OWNER_SMS_ENABLED)"}</Pill>
        </div>
        {last && <p className="mt-2 text-xs text-slate-500">Last run {new Date(last.finishedAt || last.startedAt).toLocaleString()}: {last.dryRun ? "dry, " : ""}traced {last.traced?.looked ?? last.traced?.would ?? 0}, imported {last.imported?.created ?? 0}, texts {last.texts?.scheduled ?? 0} scheduled / {last.texts?.drafted ?? 0} waiting{last.error ? ` — ${last.error}` : ""}.</p>}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-800">Pockets</h3>
          <button type="button" className={BTN} onClick={() => set({ pockets: [...f.pockets, normalizePocket({ name: `Pocket ${f.pockets.length + 1}` }, f.pockets.length)] })}><Plus className="h-3.5 w-3.5" /> Add a pocket</button>
        </div>
        {f.pockets.length === 0 && <p className="text-sm text-slate-500">No pockets yet. Add one around a street of new $3M+ builds on big lots, press Suggest from Zillow, check the numbers, save.</p>}
        {f.pockets.map((p, i) => (
          <PocketCard key={p.id || i} p={p} counts={info?.counts?.[p.id]} canSuggest={Boolean(sw.apifyToken)}
            onChange={(next) => set({ pockets: f.pockets.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => set({ pockets: f.pockets.filter((_, j) => j !== i) })} />
        ))}
      </div>

      {builders.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <h3 className="mb-2 text-sm font-bold text-slate-800">Builders who bought here ({builders.length} new builds sold)</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead><tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <th className="pb-1 pr-2">New build</th><th className="pb-1 pr-2">Sold for</th><th className="pb-1 pr-2">Lot</th><th className="pb-1 pr-2">Lot bought</th><th className="pb-1 pr-2">Builder / agent</th><th className="pb-1 pr-2">Status</th>
              </tr></thead>
              <tbody>
                {builders.map((b) => {
                  const d = b.doc || {};
                  return (
                    <tr key={b.builderKey} className="border-t border-slate-100">
                      <td className="py-1 pr-2">{String(d.address || "").split(",")[0]}{d.exitDate ? ` · ${d.exitDate.slice(0, 7)}` : ""}</td>
                      <td className="py-1 pr-2 tabular-nums">{money(d.exitPrice)}</td>
                      <td className="py-1 pr-2 tabular-nums">{d.lotSqft ? d.lotSqft.toLocaleString("en-US") : "—"}</td>
                      <td className="py-1 pr-2 tabular-nums">{d.priorLotPrice ? `${money(d.priorLotPrice)}${d.priorLotDate ? ` (${d.priorLotDate.slice(0, 7)})` : ""}` : "—"}</td>
                      <td className="py-1 pr-2">{d.builderContact?.entity || d.builder ? <><span className="font-semibold">{d.builderContact?.entity || d.builder}</span>{d.builderContact?.principal ? ` · ${d.builderContact.principal}` : ""}</> : "—"}{d.builderContact?.source && d.builderContact.source !== "none" ? <span className="text-slate-500"> ({d.builderContact.source === "lni" ? "contractor registry" : d.builderContact.source === "trace" ? "skip trace" : "county record"})</span> : null}</td>
                      <td className="py-1 pr-2">{b.status === "imported" ? "In the buyer book" : b.status === "no_phone" ? "No builder number yet" : b.status === "skipped" ? "Skipped" : "Found"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Only the builder, by their own number, goes into the buyer book: the contractor registry when the listing names them, the county's sale record for the company behind an unnamed build, a skip trace on a one-off LLC's mailing address. The listing agent is kept as a reference and never texted as a buyer.</p>
        </div>
      )}

      {owners.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <h3 className="mb-2 text-sm font-bold text-slate-800">Owners found ({owners.length} shown)</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead><tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <th className="pb-1 pr-2">House</th><th className="pb-1 pr-2">Built</th><th className="pb-1 pr-2">Lot</th><th className="pb-1 pr-2">Owner</th><th className="pb-1 pr-2">Cell</th><th className="pb-1 pr-2">Status</th><th />
              </tr></thead>
              <tbody>
                {owners.map((o) => {
                  const d = o.doc || {};
                  const cell = (d.phones || []).find((p) => p.type === "mobile" && !p.dnc && !p.litigator);
                  return (
                    <tr key={o.ownerKey} className="border-t border-slate-100">
                      <td className="py-1 pr-2">{d.house?.street}{d.house?.city ? `, ${d.house.city}` : ""}</td>
                      <td className="py-1 pr-2 tabular-nums">{d.yearBuilt || "—"}</td>
                      <td className="py-1 pr-2 tabular-nums">{d.lotSqft ? d.lotSqft.toLocaleString("en-US") : "—"}</td>
                      <td className="py-1 pr-2">{d.company || [d.first, d.last].filter(Boolean).join(" ") || "—"}</td>
                      <td className="py-1 pr-2 tabular-nums">{cell ? cell.number : d.whyNoPhone || "—"}</td>
                      <td className="py-1 pr-2">{STATUS_LABEL[o.status] || o.status}</td>
                      <td className="py-1 text-right text-xs">
                        {o.status !== "do_not_contact" && o.status !== "imported" && (
                          <button type="button" className="text-slate-500 underline hover:text-red-700" onClick={() => mark(o.ownerKey, "do_not_contact")}>Do not contact</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Statuses: {OWNER_STATUSES.map((s) => STATUS_LABEL[s]).join(" · ")}.</p>
        </div>
      )}
    </div>
  );
}
