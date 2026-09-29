import React, { useState } from "react";
import { Mail, MessageSquare, Pencil, Phone } from "lucide-react";
import { PARTY_ROLES, PARTY_LABEL, resolveParties, partyName } from "@shared/deal-parties.js";
import { updateDeal } from "./api.js";
import { BTN, BTN_PRIMARY } from "./ui.jsx";
import ContactLink from "./ContactLink.jsx";
import ContactSearch from "./ContactSearch.jsx";

const inputCls = "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none";
const SOURCE_WORDS = { offer: "from the offer", "committed buyer": "the committed buyer", "PSA settings": "from your PSA settings", "the offer's PSA": "from the offer's PSA" };
const EMPTY = { contactId: "", name: "", company: "", phone: "", email: "", note: "" };
const digits = (p) => String(p || "").replace(/[^\d+]/g, "");

/**
 * Who else is on the deal (shared/deal-parties.js): title, the seller's
 * agent, a buyer's agent, the lender, the assignee. One row each; a row
 * filled in from what the app already knows says where from, and editing it
 * stores the deal's own copy.
 */
export default function DealParties({ offer, settings, onUpdated }) {
  const parties = resolveParties(offer, settings || {});
  const [editing, setEditing] = useState(null); // null | { role, fields }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(role, value) {
    setError(""); setBusy(true);
    try {
      const r = await updateDeal(offer.id, { parties: { [role]: value } });
      if (r?.offer) onUpdated(r.offer);
      setEditing(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-1">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Parties</span>
      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {PARTY_ROLES.map((role) => {
          const p = parties[role];
          const open = editing?.role === role;
          return (
            <div key={role} className="px-3 py-2">
              <div className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-xs font-semibold text-slate-500">{PARTY_LABEL[role]}</span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {p ? (
                    <>
                      {p.contactId
                        ? <ContactLink contactId={p.contactId} name={p.name || p.company} party={role === "assignee" ? "investor" : "agent"} className="font-medium" />
                        : <span className="font-medium">{p.name || p.company}</span>}
                      {p.name && p.company && <span className="text-slate-500"> · {p.company}</span>}
                      {!p.stored && SOURCE_WORDS[p.source] && <span className="ml-1.5 text-xs text-slate-400">{SOURCE_WORDS[p.source]}</span>}
                    </>
                  ) : <span className="text-slate-400">not set</span>}
                </span>
                <span className="flex shrink-0 items-center gap-0.5 text-slate-500">
                  {p?.phone && <a href={`tel:${digits(p.phone)}`} title={`Call ${partyName(p)}`} className="rounded p-1 hover:bg-slate-100 hover:text-slate-800"><Phone size={14} /></a>}
                  {p?.phone && <a href={`sms:${digits(p.phone)}`} title={`Text ${partyName(p)}`} className="rounded p-1 hover:bg-slate-100 hover:text-slate-800"><MessageSquare size={14} /></a>}
                  {p?.email && <a href={`mailto:${p.email}`} title={`Email ${partyName(p)}`} className="rounded p-1 hover:bg-slate-100 hover:text-slate-800"><Mail size={14} /></a>}
                  {!open && (
                    <button type="button" title={p ? "Edit" : "Add"} className="rounded p-1 hover:bg-slate-100 hover:text-slate-800"
                      onClick={() => setEditing({ role, fields: { ...EMPTY, ...(p || {}) } })}>
                      {p ? <Pencil size={14} /> : <span className="px-1 text-xs font-semibold text-blue-600">Add</span>}
                    </button>
                  )}
                </span>
              </div>
              {open && (
                <div className="mt-2 space-y-2">
                  <ContactSearch busy={busy} autoFocus placeholder={`Find the ${PARTY_LABEL[role].toLowerCase()} in GHL, or type below`}
                    onPick={(c) => setEditing((e) => ({ ...e, fields: { ...e.fields, contactId: c.id, name: c.name || "", phone: c.phone || "", email: c.email || "" } }))} />
                  <div className="grid grid-cols-2 gap-2">
                    {[["name", "Name"], ["company", "Company"], ["phone", "Phone"], ["email", "Email"]].map(([k, label]) => (
                      <input key={k} className={inputCls} placeholder={label} value={editing.fields[k]}
                        onChange={(e) => setEditing((x) => ({ ...x, fields: { ...x.fields, [k]: e.target.value } }))} />
                    ))}
                  </div>
                  <input className={inputCls} placeholder="Note (file number, officer's assistant…)" value={editing.fields.note}
                    onChange={(e) => setEditing((x) => ({ ...x, fields: { ...x.fields, note: e.target.value } }))} />
                  {editing.fields.contactId && (
                    <p className="text-xs text-slate-500">Linked to a GHL contact. <button type="button" className="underline" onClick={() => setEditing((x) => ({ ...x, fields: { ...x.fields, contactId: "" } }))}>Unlink</button></p>
                  )}
                  <div className="flex gap-1.5">
                    <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => save(role, editing.fields)}>Save</button>
                    <button type="button" className={BTN} onClick={() => setEditing(null)}>Cancel</button>
                    {p?.stored && <button type="button" className={`${BTN} ml-auto`} disabled={busy} onClick={() => save(role, null)}>Clear</button>}
                  </div>
                </div>
              )}
              {p?.note && !open && <p className="mt-0.5 pl-[7.75rem] text-xs text-slate-500">{p.note}</p>}
            </div>
          );
        })}
      </div>
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
