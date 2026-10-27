// GatekeepersTab.jsx — Autopilot → Gatekeepers (2026-10-26): the people
// other than listing agents who see a house before it's listed. The
// attorney on an estate comes off the probate Notice to Creditors (pasted
// here, or the notice site's daily alert email); title and escrow officers
// come from our own closings or are typed in. Ranked by this quarter's
// estates with a house, imported to GHL tagged apart from agents.
//
// Nothing here texts or emails anyone. Import is a dry run until the
// broker's OUTREACH_IMPORTS_ENABLED is on and you press the live button.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Mail, Plus, Upload, X } from "lucide-react";
import { GATEKEEPER_KIND_LABEL } from "@shared/gatekeeper.js";
import {
  getGatekeepers, pasteProbateNotices, readNoticeMail, seedGatekeepersFromClosings, saveGatekeeper, setGatekeeperStatus, importGatekeepers,
} from "./api.js";
import { BTN, BTN_DANGER, BTN_PRIMARY, ErrorBar, FilterChips, Pill, SkeletonRows } from "./ui.jsx";

const INPUT = "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";
const STATUS_TONE = {
  new: "bg-slate-100 text-slate-600", imported: "bg-emerald-50 text-emerald-700",
  skipped: "bg-amber-50 text-amber-700", do_not_contact: "bg-red-50 text-red-700",
};
const STATUS_LABEL = { new: "New", imported: "In GHL", skipped: "Skipped", do_not_contact: "Do not contact" };
const BLANK = { kind: "title", name: "", firm: "", phone: "", email: "", closingAddress: "" };

function count(n, one, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

function noticeSummary(r) {
  const parts = [`${count(r.notices, "notice")} read`, `${count(r.attorneys?.created || 0, "new attorney")}`, `${count(r.estates?.created || 0, "new estate")}`];
  if (r.housesFound) parts.push(`${count(r.housesFound, "house")} found`);
  if (r.proSe) parts.push(`${r.proSe} with no attorney`);
  if (r.outOfArea) parts.push(`${r.outOfArea} outside our counties`);
  return parts.join(" · ");
}

export default function GatekeepersTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("all");
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(BLANK);

  const load = useCallback(() => getGatekeepers()
    .then((r) => { setData(r); setError(""); })
    .catch((e) => setError(e.message || "Couldn't load gatekeepers.")), []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => (data?.gatekeepers || []).filter((g) => kind === "all" || g.kind === kind), [data, kind]);
  const kindOptions = [
    { key: "all", label: "All", count: data?.gatekeepers?.length ?? null },
    ...Object.entries(GATEKEEPER_KIND_LABEL).map(([key, label]) => ({ key, label, count: data?.counts?.[key] ?? 0 })),
  ];

  const run = async (label, fn) => {
    setBusy(label);
    setNote("");
    try {
      const msg = await fn();
      if (msg) setNote(msg);
      await load();
    } catch (e) {
      setError(e.message || "That didn't work.");
    } finally {
      setBusy("");
    }
  };

  const togglePick = (key) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const doImport = (dryRun) => run(dryRun ? "dry" : "live", async () => {
    const r = await importGatekeepers([...picked], { dryRun });
    const failed = r.results.filter((x) => !x.ok);
    if (r.dryRun) {
      const create = r.results.filter((x) => x.wouldCreate).length;
      const update = r.results.filter((x) => x.wouldUpdate).length;
      return `Dry run: would create ${create}, would tag ${update} already in GHL${failed.length ? `, ${failed.length} can't (${failed[0].error})` : ""}.${dryRun ? "" : " Imports are switched off on the broker."}`;
    }
    setPicked(new Set());
    return `Imported: ${r.created} created, ${r.updated} already in GHL tagged${failed.length ? `, ${failed.length} failed (${failed[0].error})` : ""}.`;
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-slate-900">Gatekeepers</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          The attorney on an estate sees the house before anyone lists it, the way a listing agent does. Paste probate notices to creditors and the attorneys on them land here, ranked by this quarter's estates that own a house. Title and escrow officers come from our own closings, or add them by hand. They are sequenced on their own, apart from agents.
        </p>
      </div>

      {error && <ErrorBar>{error}</ErrorBar>}
      {note && <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800" role="status">{note}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN} onClick={() => setPasting((v) => !v)}><Upload size={12} aria-hidden="true" /> Paste notices</button>
        <button type="button" className={BTN} disabled={!!busy} onClick={() => run("mail", async () => {
          const r = await readNoticeMail();
          return r.skipped ? `Notice email: ${r.skipped}.` : `Notice email: ${count(r.messages, "message")}, ${count(r.notices, "notice")}, ${count(r.attorneys, "new attorney")}.`;
        })}>{busy === "mail" ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Mail size={12} aria-hidden="true" />} Read notice email</button>
        <button type="button" className={BTN} disabled={!!busy} onClick={() => run("seed", async () => {
          const r = await seedGatekeepersFromClosings();
          return `From ${count(r.deals, "deal")}: ${count(r.gatekeepers.created, "new title or escrow contact")}, ${count(r.closings.created, "closing")} added.`;
        })}>{busy === "seed" && <Loader2 size={12} className="animate-spin" aria-hidden="true" />} Add from our closings</button>
        <button type="button" className={BTN} onClick={() => setAdding((v) => !v)}><Plus size={12} aria-hidden="true" /> Add title / escrow</button>
        <span className="ml-auto text-xs text-slate-500">{data?.importsLive ? "Imports are live on the broker" : "Imports are dry runs (switched off on the broker)"}</span>
      </div>

      {pasting && (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
          <label htmlFor="gk-paste" className="text-xs font-semibold text-slate-600">Probate notices to creditors: paste one or many, as printed</label>
          <textarea id="gk-paste" className={INPUT} rows={8} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="flex gap-2">
            <button type="button" className={BTN_PRIMARY} disabled={!paste.trim() || !!busy} onClick={() => run("paste", async () => {
              const r = await pasteProbateNotices(paste);
              setPaste("");
              setPasting(false);
              return noticeSummary(r);
            })}>{busy === "paste" && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Read them</button>
            <button type="button" className={BTN} onClick={() => setPasting(false)}><X size={12} aria-hidden="true" /> Cancel</button>
          </div>
        </div>
      )}

      {adding && (
        <form className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-3" onSubmit={(e) => {
          e.preventDefault();
          run("add", async () => {
            const r = await saveGatekeeper(form);
            if (!r.saved?.length) throw new Error(r.skipped?.[0]?.reason || "Not saved.");
            setForm(BLANK);
            setAdding(false);
            return "Saved.";
          });
        }}>
          <label className="text-xs font-semibold text-slate-600">Kind
            <select className={INPUT} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="title">Title</option>
              <option value="escrow">Escrow</option>
              <option value="probate_attorney">Probate attorney</option>
            </select>
          </label>
          {[["name", "Name"], ["firm", "Company"], ["phone", "Phone"], ["email", "Email"], ["closingAddress", "A closing we shared (optional)"]].map(([k, label]) => (
            <label key={k} className="text-xs font-semibold text-slate-600">{label}
              <input className={INPUT} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </label>
          ))}
          <div className="flex items-end gap-2">
            <button type="submit" className={BTN_PRIMARY} disabled={!!busy || !(form.name || form.firm)}>Save</button>
            <button type="button" className={BTN} onClick={() => { setAdding(false); setForm(BLANK); }}>Cancel</button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <FilterChips value={kind} onChange={setKind} options={kindOptions} label="Kind" />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">{picked.size} picked</span>
          <button type="button" className={BTN} disabled={!picked.size || !!busy} onClick={() => doImport(true)}>
            {busy === "dry" && <Loader2 size={12} className="animate-spin" aria-hidden="true" />} Dry run
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={!picked.size || !!busy || !data?.importsLive} onClick={() => doImport(false)}
            title={data?.importsLive ? "Create them in GHL, tagged gatekeeper" : "Imports are switched off on the broker"}>
            {busy === "live" && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Import to GHL
          </button>
        </div>
      </div>

      {!data && !error ? <SkeletonRows cols={6} /> : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
              <tr>
                <th className="w-8 px-3 py-2"><span className="sr-only">Pick</span></th>
                <th className="px-3 py-2">Who</th>
                <th className="px-3 py-2">Why them</th>
                <th className="px-3 py-2">Opens with</th>
                <th className="px-3 py-2">Reach</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-500">No gatekeepers yet. Paste a few probate notices or add from our closings.</td></tr>
              )}
              {rows.map((g) => {
                const pickable = g.status === "new" || g.status === "skipped";
                return (
                  <tr key={g.gkKey} className="align-top">
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label={`Pick ${g.name || g.firm}`} disabled={!pickable} checked={picked.has(g.gkKey)} onChange={() => togglePick(g.gkKey)} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{g.name || g.firm || "—"}</div>
                      <div className="text-xs text-slate-500">{[GATEKEEPER_KIND_LABEL[g.kind], g.name ? g.firm : "", (g.counties || []).join(", ")].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">{g.rank?.why || "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{g.hookLine || "—"}{g.hooks > 1 ? <span className="text-slate-400"> (+{g.hooks - 1})</span> : null}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{[g.email ? "email" : "", g.phone ? "phone" : ""].filter(Boolean).join(" · ") || <span className="text-amber-700">needs a phone or email</span>}</td>
                    <td className="px-3 py-2"><Pill small label={STATUS_LABEL[g.status] || g.status} cls={STATUS_TONE[g.status]} /></td>
                    <td className="px-3 py-2 text-right">
                      {g.status === "new" && (
                        <button type="button" className={BTN} disabled={!!busy} onClick={() => run("status", () => setGatekeeperStatus(g.gkKey, "skipped").then(() => ""))}>Skip</button>
                      )}
                      {g.status !== "do_not_contact" && g.status !== "imported" && (
                        <button type="button" className={`${BTN_DANGER} ml-1`} disabled={!!busy} onClick={() => run("status", () => setGatekeeperStatus(g.gkKey, "do_not_contact").then(() => ""))}>Do not contact</button>
                      )}
                      {(g.status === "skipped" || g.status === "do_not_contact") && (
                        <button type="button" className={`${BTN} ml-1`} disabled={!!busy} onClick={() => run("status", () => setGatekeeperStatus(g.gkKey, "new").then(() => ""))}>Back to new</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
