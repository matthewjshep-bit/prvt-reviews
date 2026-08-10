// FieldsManager.jsx — one place to see and manage every contact field.
// Definitions pane: all custom fields in the GHL location grouped by which
// app feature owns them (offer writes, outreach imports, AI enrichment) vs
// "other", with create-missing and delete. Preview pane: pick a real contact
// and see/edit standard + custom field values in one table, plus the
// contact's app deals (agent or investor side).

import React, { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Plus, Trash2, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import {
  createCustomField, getContactRecord, getFieldRegistry, ghlContactUrl,
  listCustomFields, pruneCustomFields, saveContactRecord, searchContacts,
} from "./api.js";
import { StagePill } from "./DealsView.jsx";

const SOURCE_ORDER = ["offers", "outreach", "enrich-shared", "enrich-agent", "enrich-investor", "other"];
const SOURCE_LABELS = {
  offers: "Offer generator",
  outreach: "Agent outreach",
  "enrich-shared": "AI enrichment — shared",
  "enrich-agent": "AI enrichment — agents",
  "enrich-investor": "AI enrichment — investors",
  other: "Other fields in GHL",
};

const prettyEnum = (v) => String(v || "").replace(/_/g, " ");
const stripPrefix = (fk) => String(fk || "").replace(/^contact\./, "");

const Chip = ({ cls, children }) => (
  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>
);

const INPUT_CLS = "w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none";

/* ---------- definitions pane ---------- */

function DefinitionsPane() {
  const [ghlFields, setGhlFields] = useState(null);
  const [registry, setRegistry] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(""); // "" | key being created | "bulk" | id being deleted
  const [confirmDelete, setConfirmDelete] = useState(null); // ghl field id
  const [progress, setProgress] = useState("");
  const [newField, setNewField] = useState({ name: "", dataType: "TEXT" });

  const load = () =>
    Promise.all([listCustomFields(), getFieldRegistry()])
      .then(([f, r]) => { setGhlFields(f); setRegistry(r); })
      .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error) return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
  if (!ghlFields || !registry) return <div className="flex justify-center p-10"><Loader2 className="animate-spin text-slate-400" /></div>;

  // Join GHL definitions against the app registry — same rule the broker
  // uses when creating (match by key, else by name).
  const contactDefs = ghlFields.filter((d) => !d.model || d.model === "contact");
  const claimed = new Map(); // registry key -> ghl def
  const extras = []; // ghl defs claimed by an already-taken key (duplicates)
  const others = [];
  for (const def of contactDefs) {
    const key = stripPrefix(def.fieldKey) || def.id;
    const reg = registry.find((r) => r.key === key)
      || registry.find((r) => r.name.toLowerCase() === String(def.name || "").toLowerCase());
    if (!reg) { others.push(def); continue; }
    if (claimed.has(reg.key)) extras.push(def);
    else claimed.set(reg.key, def);
  }
  const missing = registry.filter((r) => !claimed.has(r.key));

  async function createOne(row) {
    setBusy(row.key);
    setError("");
    try {
      await createCustomField({ key: row.key, name: row.name, dataType: row.dataType === "NUMERICAL" ? "NUMERICAL" : "TEXT" });
      await load();
    } catch (e) { setError(e.message); }
    setBusy("");
  }

  async function createAllMissing() {
    setBusy("bulk");
    setError("");
    let done = 0;
    for (const row of missing) {
      setProgress(`Creating ${done + 1}/${missing.length} — ${row.name}`);
      try {
        await createCustomField({ key: row.key, name: row.name, dataType: row.dataType === "NUMERICAL" ? "NUMERICAL" : "TEXT" });
        done++;
      } catch (e) { setError(`${row.name}: ${e.message}`); break; }
    }
    setProgress("");
    setBusy("");
    await load();
  }

  async function deleteOne(def, isAppField) {
    setBusy(def.id);
    setError("");
    try {
      const r = await pruneCustomFields([def.id]);
      const bad = (r.results || []).find((x) => !x.ok);
      if (bad) setError(`Delete failed: ${bad.error}`);
      await load();
    } catch (e) { setError(e.message); }
    setConfirmDelete(null);
    setBusy("");
  }

  async function createNew() {
    if (!newField.name.trim()) return;
    setBusy("new");
    setError("");
    try {
      await createCustomField({ name: newField.name.trim(), dataType: newField.dataType });
      setNewField({ name: "", dataType: "TEXT" });
      await load();
    } catch (e) { setError(e.message); }
    setBusy("");
  }

  const renderRow = ({ reg, def }) => {
    const key = def ? stripPrefix(def.fieldKey) : reg.key;
    const isApp = Boolean(reg);
    const typeMismatch = reg && def && reg.dataType !== def.dataType
      && !(reg.dataType === "TEXT" && !def.dataType);
    return (
      <React.Fragment key={reg?.key || def.id}>
        <tr className="border-b border-slate-100 last:border-0">
          <td className="px-3 py-2">
            <div className="font-medium">{reg?.name || def.name}</div>
            {reg?.values && (
              <div className="mt-0.5 max-w-[22rem] text-[11px] leading-tight text-slate-400">
                {reg.values.map(prettyEnum).join(" · ")}
              </div>
            )}
          </td>
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-500">
            {def ? def.fieldKey || key : `contact.${reg.key}`}
          </td>
          <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600">
            {(def?.dataType || reg?.dataType || "TEXT")}
            {typeMismatch && <span className="ml-1 text-amber-600">(app expects {reg.dataType})</span>}
          </td>
          <td className="whitespace-nowrap px-3 py-2">
            {def ? <Chip cls="bg-emerald-100 text-emerald-800">in GHL</Chip>
                 : <Chip cls="bg-amber-100 text-amber-800">not created</Chip>}
            {reg?.serverSet && <Chip cls="ml-1 bg-slate-200 text-slate-600">auto</Chip>}
            {reg && def && reg.key !== stripPrefix(def.fieldKey) && (
              <Chip cls="ml-1 bg-amber-100 text-amber-800" title="Matched by name; the GHL key differs from the app's key">key differs</Chip>
            )}
          </td>
          <td className="whitespace-nowrap px-3 py-2 text-right">
            {!def && (
              <button type="button" disabled={Boolean(busy)} onClick={() => createOne(reg)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50">
                {busy === reg.key ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Create
              </button>
            )}
            {def && (
              <button type="button" disabled={Boolean(busy)}
                onClick={() => setConfirmDelete(confirmDelete === def.id ? null : def.id)}
                className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete field">
                <Trash2 size={14} />
              </button>
            )}
          </td>
        </tr>
        {def && confirmDelete === def.id && (
          <tr className="border-b border-slate-100 bg-red-50">
            <td colSpan={5} className="px-3 py-2 text-xs text-red-800">
              Permanently deletes this field <span className="font-bold">and erases its values on every contact</span>.
              {isApp && " The app will recreate the definition (empty) on its next write."}
              <button type="button" disabled={Boolean(busy)} onClick={() => deleteOne(def, isApp)}
                className="ml-3 rounded-lg bg-red-600 px-2.5 py-1 font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                {busy === def.id ? "Deleting…" : "Delete field"}
              </button>
              <button type="button" onClick={() => setConfirmDelete(null)}
                className="ml-2 rounded-lg border border-red-300 px-2.5 py-1 font-semibold text-red-700 hover:bg-red-100">
                Cancel
              </button>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  const groups = SOURCE_ORDER.map((source) => {
    if (source === "other") {
      return { source, rows: [...others, ...extras].map((def) => ({ reg: null, def })) };
    }
    return {
      source,
      rows: registry.filter((r) => r.source === source).map((reg) => ({ reg, def: claimed.get(reg.key) || null })),
    };
  }).filter((g) => g.rows.length);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-slate-600">
          {contactDefs.length} field{contactDefs.length === 1 ? "" : "s"} in GHL · {missing.length} app field{missing.length === 1 ? "" : "s"} not created yet
        </div>
        {missing.length > 0 && (
          <button type="button" disabled={Boolean(busy)} onClick={createAllMissing}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {busy === "bulk" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            Create all {missing.length} missing
          </button>
        )}
      </div>
      {progress && <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{progress}</div>}

      {groups.map((g) => (
        <div key={g.source}>
          <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">{SOURCE_LABELS[g.source]}</div>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2">Field</th>
                  <th className="px-3 py-2">Key</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>{g.rows.map(renderRow)}</tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="rounded-xl border border-dashed border-slate-300 p-3">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">New custom field</div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="min-w-[16rem] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="Field name, e.g. Preferred Lender"
            value={newField.name} onChange={(e) => setNewField((f) => ({ ...f, name: e.target.value }))} />
          <select className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            value={newField.dataType} onChange={(e) => setNewField((f) => ({ ...f, dataType: e.target.value }))}>
            <option value="TEXT">Text</option>
            <option value="NUMERICAL">Number</option>
            <option value="DATE">Date</option>
          </select>
          <button type="button" disabled={Boolean(busy) || !newField.name.trim()} onClick={createNew}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50">
            {busy === "new" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- contact preview pane ---------- */

function PreviewPane() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null); // { standard: {...}, fields: {id: value} }
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!query.trim() || query.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(() => {
      setSearching(true);
      searchContacts(query.trim())
        .then(setResults).catch(() => setResults([])).finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query]);

  async function pick(c) {
    setOpen(false);
    setQuery("");
    setResults([]);
    setError("");
    setLoading(true);
    try {
      const r = await getContactRecord(c.id);
      setRecord(r);
      setDraft({
        standard: {
          firstName: r.contact.firstName, lastName: r.contact.lastName,
          phone: r.contact.phone, email: r.contact.email,
        },
        fields: Object.fromEntries(r.fields.map((f) => [f.id, f.value])),
      });
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  const changedFields = record && draft
    ? record.fields.filter((f) => String(draft.fields[f.id] ?? "") !== String(f.value ?? ""))
    : [];
  const changedStandard = record && draft
    ? ["firstName", "lastName", "phone", "email"].filter((k) => (draft.standard[k] ?? "") !== (record.contact[k] ?? ""))
    : [];
  const changeCount = changedFields.length + changedStandard.length;

  async function save() {
    setSaving(true);
    setError("");
    try {
      await saveContactRecord(record.contact.id, {
        standard: Object.fromEntries(changedStandard.map((k) => [k, draft.standard[k]])),
        fields: changedFields.map((f) => ({ id: f.id, key: f.source !== "other" ? f.key : undefined, value: draft.fields[f.id] })),
      });
      await pick({ id: record.contact.id }); // refetch
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  const setField = (id, v) => setDraft((d) => ({ ...d, fields: { ...d.fields, [id]: v } }));
  const setStd = (k, v) => setDraft((d) => ({ ...d, standard: { ...d.standard, [k]: v } }));

  const valueEditor = (f) => {
    const v = draft.fields[f.id] ?? "";
    if (f.values && !f.multi) {
      const opts = f.values.includes(v) || !v ? f.values : [v, ...f.values]; // keep legacy value visible
      return (
        <select className={INPUT_CLS} value={v} onChange={(e) => setField(f.id, e.target.value)}>
          <option value="">—</option>
          {opts.map((o) => <option key={o} value={o}>{prettyEnum(o)}</option>)}
        </select>
      );
    }
    if (f.picklistOptions?.length) {
      const opts = f.picklistOptions.includes(v) || !v ? f.picklistOptions : [v, ...f.picklistOptions];
      return (
        <select className={INPUT_CLS} value={v} onChange={(e) => setField(f.id, e.target.value)}>
          <option value="">—</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    // History ledgers (deal/property history) are multi-line — a one-line
    // input would hide everything but the first event.
    if (f.append) {
      return (
        <textarea rows={4} className={INPUT_CLS} value={v} placeholder="—"
          onChange={(e) => setField(f.id, e.target.value)} />
      );
    }
    return (
      <div>
        <input className={INPUT_CLS}
          type={f.dataType === "NUMERICAL" ? "number" : "text"}
          value={v} placeholder="—"
          onChange={(e) => setField(f.id, e.target.value)} />
        {f.multi && f.values && (
          <div className="mt-0.5 text-[10px] text-slate-400">comma-separate: {f.values.join(", ")}</div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* typeahead */}
      <div className="relative max-w-md">
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search a contact to preview…"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        {searching && <Loader2 size={14} className="absolute right-3 top-3 animate-spin text-slate-400" />}
        {open && results.length > 0 && (
          <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            {results.map((c) => (
              <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50">
                <span className="font-medium">{c.name || "(no name)"}</span>
                <span className="text-xs text-slate-500">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {loading && <div className="flex justify-center p-8"><Loader2 className="animate-spin text-slate-400" /></div>}

      {!record && !loading && (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">
          Pick a contact to see every field on their record.
        </div>
      )}

      {record && draft && !loading && (
        <>
          {/* standard fields */}
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-bold">{record.contact.name || "(no name)"}</span>
              <a href={ghlContactUrl(record.contact.id)} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-slate-500 underline hover:text-slate-900">
                Open in GHL <ExternalLink size={11} />
              </a>
              <span className="ml-auto text-xs text-slate-400">
                {record.contact.dateAdded && `added ${String(record.contact.dateAdded).slice(0, 10)}`}
                {record.contact.source && ` · source: ${record.contact.source}`}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              {[["firstName", "First name"], ["lastName", "Last name"], ["phone", "Phone"], ["email", "Email"]].map(([k, label]) => (
                <div key={k}>
                  <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
                  <input className={INPUT_CLS} value={draft.standard[k] ?? ""} onChange={(e) => setStd(k, e.target.value)} />
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              {(record.contact.tags || []).map((t) => (
                <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{t}</span>
              ))}
              {[record.contact.address1, record.contact.city, record.contact.state].filter(Boolean).length > 0 && (
                <span className="ml-auto text-slate-400">
                  {[record.contact.address1, record.contact.city, record.contact.state, record.contact.postalCode].filter(Boolean).join(", ")}
                </span>
              )}
            </div>
          </div>

          {/* custom fields grouped by source */}
          {SOURCE_ORDER.map((source) => {
            const rows = record.fields.filter((f) => f.source === source);
            if (!rows.length) return null;
            return (
              <div key={source}>
                <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">{SOURCE_LABELS[source]}</div>
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full text-sm">
                    <tbody>
                      {rows.map((f) => (
                        <tr key={f.id} className="border-b border-slate-100 last:border-0">
                          <td className="w-64 px-3 py-2">
                            <div className="font-medium">{f.name}</div>
                            <div className="font-mono text-[10px] text-slate-400">{f.fieldKey || f.key}</div>
                          </td>
                          <td className="px-3 py-2">{valueEditor(f)}</td>
                          <td className="w-20 whitespace-nowrap px-3 py-2 text-right">
                            {f.serverSet && <Chip cls="bg-slate-200 text-slate-600">auto</Chip>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

          {/* app deals */}
          {record.deals.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
                Deals (manage in the Deals tab)
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {record.deals.map((d, i) => (
                  <div key={`${d.id}-${d.role}-${i}`} className="rounded-xl border border-slate-200 p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{d.address || "—"}</span>
                      <StagePill stage={d.stage} small />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                      <span className="font-semibold uppercase text-slate-400">{d.role}{d.investorStatus ? ` · ${d.investorStatus}` : ""}</span>
                      {d.contractPrice && <span>{fmtMoney(d.contractPrice)}</span>}
                      {d.assignmentFee && <span className="text-emerald-700">fee {fmtMoney(d.assignmentFee)}</span>}
                      {d.closingDate && <span>closes {d.closingDate}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* save bar */}
          <div className="sticky bottom-0 -mx-1 flex items-center gap-3 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
            <button type="button" disabled={saving || changeCount === 0} onClick={save}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Save {changeCount || ""} change{changeCount === 1 ? "" : "s"}
            </button>
            {changeCount > 0 && (
              <button type="button" disabled={saving}
                onClick={() => setDraft({
                  standard: {
                    firstName: record.contact.firstName, lastName: record.contact.lastName,
                    phone: record.contact.phone, email: record.contact.email,
                  },
                  fields: Object.fromEntries(record.fields.map((f) => [f.id, f.value])),
                })}
                className="text-sm font-medium text-slate-500 hover:text-slate-900">
                Discard
              </button>
            )}
            {savedFlash && <span className="text-sm font-medium text-emerald-700">Saved ✓</span>}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- shell ---------- */

export default function FieldsManager({ onClose }) {
  const [pane, setPane] = useState("definitions");
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-5xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">CRM fields</div>
            <div className="text-sm text-slate-500">
              Every contact field in one place — what the app manages, what else is in GHL, and a live contact preview.
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>
        <div className="mb-4 flex gap-1.5">
          {[["definitions", "Field definitions"], ["preview", "Contact preview"]].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setPane(k)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${
                pane === k ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}>
              {label}
            </button>
          ))}
        </div>
        {pane === "definitions" ? <DefinitionsPane /> : <PreviewPane />}
      </div>
    </div>
  );
}
