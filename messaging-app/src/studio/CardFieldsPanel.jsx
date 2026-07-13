// CardFieldsPanel.jsx — the honest-fields surface for the Card Studio. Lists
// every binding the current template references with a LIVE status (real GHL
// field / missing — create it / app-provided / data-source), plus an
// "add a field to the card" flow over the location's actual custom fields.
// Prevents the "looks fine in the editor, renders blank at send time" trap.

import React, { useMemo, useState } from "react";
import { extractTemplateBindings } from "@shared/bindings.js";
import { newLayer } from "./model.js";

const STD_CONTACT = new Set(["first_name", "last_name", "phone", "email", "address1", "city", "state", "address_full"]);
const TYPE_OPTIONS = [["TEXT", "Text"], ["NUMERICAL", "Number"], ["DATE", "Date"]];

const pretty = (key) => key.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

// GHL fieldKey "contact.<key>" ↔ binding "contact.custom.<key>".
const ghlKeys = (customFields) =>
  new Set((customFields || []).map((f) => String(f.fieldKey || "").replace(/^contact\./, "")).filter(Boolean));

function classify(binding, { defined, dataSourceIds }) {
  if (binding.startsWith("contact.custom.")) {
    const key = binding.slice("contact.custom.".length);
    return defined.has(key)
      ? { tone: "ok", label: "✓ GHL field", key }
      : { tone: "warn", label: "not in GHL", key, creatable: true };
  }
  if (binding.startsWith("contact.")) {
    const key = binding.slice("contact.".length);
    return STD_CONTACT.has(key)
      ? { tone: "info", label: "built-in" }
      : { tone: "warn", label: "unknown contact field" };
  }
  if (binding.startsWith("loc.")) return { tone: "info", label: "location setting" };
  if (binding.startsWith("data.tier.")) return { tone: "info", label: "app-provided · tiers" };
  if (binding.startsWith("data.")) {
    const id = binding.split(".")[1];
    return dataSourceIds.has(id)
      ? { tone: "ok", label: `from source “${id}”` }
      : { tone: "warn", label: `no data source “${id}”` };
  }
  return { tone: "warn", label: "unknown" };
}

const PILL_TONE = {
  ok: "bg-green-50 text-green-700",
  info: "bg-gray-100 text-gray-500",
  warn: "bg-amber-50 text-amber-700",
};

export default function CardFieldsPanel({ template, customFields, onCreateField, patchTemplate, showToast }) {
  const [busyKey, setBusyKey] = useState(null);
  const [createType, setCreateType] = useState({}); // binding -> dataType
  const [addSel, setAddSel] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("TEXT");
  const [newBusy, setNewBusy] = useState(false);

  const defined = useMemo(() => ghlKeys(customFields), [customFields]);
  const dataSourceIds = useMemo(() => new Set((template.dataSources || []).map((d) => d.id)), [template.dataSources]);
  const bindings = useMemo(() => extractTemplateBindings(template), [template]);

  // Add a text layer bound to a field.
  function addFieldLayer(token) {
    const layer = { ...newLayer("text"), content: `{{${token}}}` };
    patchTemplate({ layers: [...(template.layers || []), layer] });
    showToast(`Added {{${token}}} to the card`);
  }

  async function createFor(binding, key) {
    setBusyKey(binding);
    try {
      await onCreateField(pretty(key), createType[binding] || "TEXT");
      showToast(`Created "${pretty(key)}" in GHL`);
    } catch (e) {
      showToast("Couldn’t create: " + (e.message || "error"));
    } finally {
      setBusyKey(null);
    }
  }

  async function createNew() {
    if (!newName.trim()) return;
    setNewBusy(true);
    try {
      const r = await onCreateField(newName.trim(), newType);
      showToast(`Created "${newName.trim()}" in GHL`);
      if (r?.key) addFieldLayer(`contact.custom.${r.key}`);
      setNewName("");
    } catch (e) {
      showToast("Couldn’t create: " + (e.message || "error"));
    } finally {
      setNewBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-gray-400">Card fields</span>
        <span className="text-[11px] text-gray-400">what this card pulls per contact</span>
      </div>

      {/* fields referenced by the template */}
      {bindings.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400">
          No fields on this card yet — static text only.
        </div>
      ) : (
        <div className="space-y-1">
          {bindings.map((b) => {
            const c = classify(b, { defined, dataSourceIds });
            return (
              <div key={b} className="flex items-center justify-between gap-2 rounded-md border border-gray-100 px-2.5 py-1.5">
                <code className="truncate text-xs text-gray-700">{`{{${b}}}`}</code>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${PILL_TONE[c.tone]}`}>{c.label}</span>
                  {c.creatable ? (
                    <>
                      <select
                        value={createType[b] || "TEXT"}
                        onChange={(e) => setCreateType((p) => ({ ...p, [b]: e.target.value }))}
                        className="rounded border border-gray-200 px-1 py-0.5 text-[11px] text-gray-600"
                      >
                        {TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <button
                        type="button"
                        disabled={busyKey === b}
                        onClick={() => createFor(b, c.key)}
                        className="rounded-md bg-amber-500 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                      >
                        {busyKey === b ? "…" : "Create"}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* add an existing field / create new */}
      <div className="mt-3 border-t border-gray-100 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={addSel}
            onChange={(e) => setAddSel(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">Add a field to the card…</option>
            {(customFields || []).map((f) => {
              const key = String(f.fieldKey || "").replace(/^contact\./, "");
              if (!key) return null;
              return <option key={f.id || key} value={`contact.custom.${key}`}>{f.name || key}</option>;
            })}
          </select>
          <button
            type="button"
            disabled={!addSel}
            onClick={() => { addFieldLayer(addSel); setAddSel(""); }}
            className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Add
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="＋ New field name (e.g. Warranty Expiry)…"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
          <select value={newType} onChange={(e) => setNewType(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button
            type="button"
            disabled={!newName.trim() || newBusy}
            onClick={createNew}
            className="rounded-lg bg-gray-900 px-2.5 py-1.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-40"
          >
            {newBusy ? "Creating…" : "Create & add"}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-gray-400">
          Creates a real GHL custom field — it becomes editable on contacts and available to every card.
        </p>
      </div>
    </div>
  );
}
