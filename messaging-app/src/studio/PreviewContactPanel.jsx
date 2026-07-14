// PreviewContactPanel.jsx — the Design step's left rail. Two jobs:
//
//   1. "Preview as" — pick a REAL contact and the canvas becomes the actual
//      server render for them (real imagery + real values). Clear to edit.
//   2. The sample-contact card — every available field with a visible value
//      (real contact's, or editable sample data), each row draggable onto the
//      canvas / click-to-add. This replaces the anonymous chip pile: you see
//      what a field IS before you put it on the card.

import React, { useEffect, useMemo, useState } from "react";
import { API_BASE, getLocationId, searchContacts, createCustomField } from "./api.js";

const STD_FIELDS = [
  ["contact.first_name", "First name"],
  ["contact.last_name", "Last name"],
  ["contact.phone", "Phone"],
  ["contact.email", "Email"],
  ["contact.address_full", "Full address"],
];
const LOC_FIELDS = [
  ["loc.business_name", "Business name"],
  ["loc.owner_first_name", "Owner first name"],
];
const TIER_FIELDS = [
  ["data.tier.rate", "Tier rate"],
  ["data.tier.down", "Tier down"],
  ["data.tier.proof", "Tier proof"],
  ["data.tier.label", "Tier label"],
];
const TYPE_OPTIONS = [["TEXT", "Text"], ["NUMERICAL", "Number"], ["DATE", "Date"]];

function Group({ title, children }) {
  return (
    <div className="mb-3">
      <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">{title}</div>
      <div className="overflow-hidden rounded-lg border border-gray-100">{children}</div>
    </div>
  );
}

function FieldRow({ token, label, value, editable, onEditValue, onAdd, onCard }) {
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/x-binding", token)}
      className="group flex cursor-grab items-center gap-2 border-t border-gray-50 bg-white px-2 py-1.5 first:border-t-0 hover:bg-blue-50/50 active:cursor-grabbing"
      title={`{{${token}}} — drag onto the card`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 truncate text-[11px] font-medium text-gray-500">
          {label}
          {onCard ? <span className="text-green-500" title="On the card">•</span> : null}
        </div>
        {editable ? (
          <input
            value={value}
            onChange={(e) => onEditValue(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder="sample value…"
            className="w-full truncate border-0 bg-transparent p-0 text-xs text-gray-800 outline-none placeholder:text-gray-300"
          />
        ) : (
          <div className="truncate text-xs text-gray-800">{value || <span className="text-gray-300">—</span>}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="shrink-0 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 opacity-0 transition-opacity hover:bg-gray-50 group-hover:opacity-100"
        title="Add to card"
      >
        ＋ add
      </button>
    </div>
  );
}

export default function PreviewContactPanel({
  template,            // live template (for sampleData + referenced bindings + data sources)
  referenced,          // Set of binding tokens on the card
  previewContact,      // { id, name, fields } | null
  onSelectContact,     // (contact|null) => void
  renderUrl,           // the contact's true server render (mini preview)
  renderLoading,       // server render in-flight
  onRefreshRender,     // re-render the mini preview with current edits
  onAddField,          // (token) => void
  onEditSample,        // (token, value) => void
  onCreatedField,      // () => void  (refresh customFields upstream)
  showToast,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("TEXT");
  const [creating, setCreating] = useState(false);
  const locationId = getLocationId();

  useEffect(() => {
    fetch(`${API_BASE}/api/locations/${encodeURIComponent(locationId)}/custom-fields`)
      .then((r) => (r.ok ? r.json() : { customFields: [] }))
      .then((d) => setCustomFields(d.customFields || []))
      .catch(() => {});
  }, [locationId]);

  // Debounced contact search.
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const t = setTimeout(() => searchContacts(query.trim()).then(setResults), 300);
    return () => clearTimeout(t);
  }, [query]);

  async function pick(c) {
    setQuery("");
    setResults([]);
    try {
      const r = await fetch(`${API_BASE}/api/contacts/${c.id}/preview?location_id=${encodeURIComponent(locationId)}`);
      const d = await r.json();
      onSelectContact({
        id: c.id,
        name: d.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "Contact",
        fields: d.fields || {},
      });
    } catch {
      onSelectContact({ id: c.id, name: c.firstName || "Contact", fields: {} });
    }
  }

  const valueOf = (token) =>
    previewContact ? previewContact.fields?.[token] ?? "" : template?.sampleData?.[token] ?? "";

  const groups = useMemo(() => {
    const custom = (customFields || [])
      .map((f) => {
        const key = String(f.fieldKey || "").replace(/^contact\./, "");
        return key ? [`contact.custom.${key}`, f.name || key] : null;
      })
      .filter(Boolean);
    const sources = (template?.dataSources || []).flatMap((ds) =>
      (ds.discoveredKeys || []).map((k) => [`data.${ds.id}.${k}`, `${ds.id} · ${k}`])
    );
    return [
      ["Contact", STD_FIELDS],
      ["Custom fields", custom],
      ["Business", LOC_FIELDS],
      ["Offer tiers", TIER_FIELDS],
      ...(sources.length ? [["Data sources", sources]] : []),
    ];
  }, [customFields, template?.dataSources]);

  async function createField() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const r = await createCustomField({ name: newName.trim(), dataType: newType });
      setCustomFields(await fetch(`${API_BASE}/api/locations/${encodeURIComponent(locationId)}/custom-fields`).then((x) => x.json()).then((d) => d.customFields || []));
      onCreatedField?.();
      if (r?.key) onAddField(`contact.custom.${r.key}`);
      showToast?.(`Created "${newName.trim()}"`);
      setNewName("");
    } catch (e) {
      showToast?.("Couldn’t create: " + (e.message || "error"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      {/* preview-as */}
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">Preview as</div>
      {previewContact ? (
        <div className="mb-3">
          <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-2.5 py-2 text-sm">
            <span className="truncate font-medium text-green-800">{previewContact.name}</span>
            <button type="button" onClick={() => onSelectContact(null)} className="ml-2 shrink-0 text-xs font-semibold text-green-700 underline hover:text-green-900">
              ✕ clear
            </button>
          </div>
          <p className="mt-1 text-[10px] text-gray-400">
            The canvas shows their values and stays editable. This is their real render:
          </p>
          {/* the contact's TRUE server render — real imagery + values */}
          <div className="relative mt-1 overflow-hidden rounded-lg bg-[#0b0b0c]">
            {renderUrl ? (
              <img src={renderUrl} alt={`Render for ${previewContact.name}`} className="w-full" />
            ) : (
              <div
                className="flex w-full items-center justify-center text-[11px] text-gray-500"
                style={{ aspectRatio: `${template?.canvas?.width || 1} / ${template?.canvas?.height || 1}` }}
              >
                {renderLoading ? "Rendering…" : "No render yet"}
              </div>
            )}
            {renderLoading && renderUrl ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-[11px] font-medium text-white">
                Rendering…
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onRefreshRender}
            disabled={renderLoading}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {renderLoading ? "Rendering…" : "↻ Refresh with my edits"}
          </button>
        </div>
      ) : (
        <div className="relative mb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a real contact…"
            className="w-full rounded-lg border border-gray-300 px-2.5 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          {results.length > 0 && (
            <div className="absolute z-20 mt-1 max-h-44 w-full overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg">
              {results.map((c) => (
                <button key={c.id} type="button" onClick={() => pick(c)}
                  className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-sm hover:bg-gray-50">
                  <span className="truncate font-medium text-gray-800">{[c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "Unnamed"}</span>
                  <span className="ml-2 shrink-0 text-[10px] text-gray-400">{c.phone}</span>
                </button>
              ))}
            </div>
          )}
          <p className="mt-1 text-[10px] text-gray-400">Pick a contact to see their real card, or edit sample values below.</p>
        </div>
      )}

      {/* the sample/real contact's fields */}
      <div className="mb-1 flex items-baseline justify-between px-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
          {previewContact ? "Their fields" : "Sample contact"}
        </span>
        <span className="text-[10px] text-gray-300">drag onto card</span>
      </div>
      <div className="max-h-[46vh] overflow-y-auto pr-0.5">
        {groups.map(([title, fields]) =>
          fields.length ? (
            <Group key={title} title={title}>
              {fields.map(([token, label]) => (
                <FieldRow
                  key={token}
                  token={token}
                  label={label}
                  value={valueOf(token)}
                  editable={!previewContact}
                  onEditValue={(v) => onEditSample(token, v)}
                  onAdd={() => onAddField(token)}
                  onCard={referenced?.has(token)}
                />
              ))}
            </Group>
          ) : null
        )}
      </div>

      {/* create a new field */}
      <div className="mt-2 border-t border-gray-100 pt-2">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="＋ New field…"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs"
          />
          <select value={newType} onChange={(e) => setNewType(e.target.value)} className="rounded-lg border border-gray-300 px-1 py-1.5 text-xs">
            {TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button
            type="button"
            disabled={!newName.trim() || creating}
            onClick={createField}
            className="rounded-lg bg-gray-900 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            {creating ? "…" : "Create"}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-gray-400">Creates a real GHL field, editable on every contact.</p>
      </div>
    </div>
  );
}
