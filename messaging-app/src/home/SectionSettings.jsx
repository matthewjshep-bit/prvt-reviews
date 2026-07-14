// home/SectionSettings.jsx — the "Card & message" panel, identical for every
// section. This is where a section's send is DEFINED: which card template it
// uses (explicit assignment, survives renames) and the outgoing message text.
// Opens from the header chip or the footer's "Edit message" button.

import React, { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import * as api from "./api.js";
import { SendButton, SecondaryButton } from "./ui.jsx";
import FieldWithTags from "../studio/MergeTagField.jsx";
import { mergeTagGroups } from "../studio/model.js";
import { getCustomFields } from "../studio/api.js";

// Jump to the Card Studio view with a specific template open. Sets the URL and
// pings HomePage's popstate listener so the view switches without a reload.
export function gotoStudio(templateId) {
  try {
    const p = new URLSearchParams(window.location.search);
    p.set("view", "studio");
    if (templateId) p.set("template", templateId);
    else p.delete("template");
    window.history.pushState(null, "", `${window.location.pathname}?${p}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch { /* ignore */ }
}

export default function SectionSettings({ open, onClose, data, onSaved }) {
  const section = data?.section;
  const [templateId, setTemplateId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Re-seed the form each time the panel opens.
  useEffect(() => {
    if (!open || !data) return;
    setTemplateId(data.templateId || "");
    setMessage(data.message || "");
    setError(null);
  }, [open, data]);

  // Full merge-tag picker for the message (all custom fields + tier data,
  // which the broker injects on every section's send).
  const [customFields, setCustomFields] = useState([]);
  useEffect(() => { if (open) getCustomFields().then(setCustomFields); }, [open]);
  const tagGroups = useMemo(
    () => [
      ...mergeTagGroups({ customFields }),
      { group: "Offer tiers", tags: ["rate", "down", "proof", "label"].map((k) => ({ token: `data.tier.${k}`, label: `tier ${k}` })) },
    ],
    [customFields]
  );

  if (!open || !data) return null;

  const templates = data.templates || [];
  const presetName = { quotes: "Quote Follow-Up", reviews: "Review Request", winback: "Property Card", offers: "Offer Terms" }[section];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveSectionConfig(section, {
        templateId: templateId || null,
        message,
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e.message || "Couldn’t save");
    } finally {
      setBusy(false);
    }
  }

  async function usePreset() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createFromPreset(section);
      setTemplateId(r.template.id);
      onSaved?.(); // assignment already persisted server-side
    } catch (e) {
      setError(e.message || "Couldn’t create the preset");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Card &amp; message</h3>
            <p className="text-sm text-gray-500">What {data.label || section} sends</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* card template */}
        <label className="mb-1 block text-sm font-semibold text-gray-900">Card template</label>
        <div className="flex gap-2">
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="">— no card assigned —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {templateId ? (
            <button
              type="button"
              onClick={() => gotoStudio(templateId)}
              className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Edit design
            </button>
          ) : null}
        </div>
        <div className="mt-1.5 text-xs text-gray-400">
          {templateId
            ? "This exact template is sent — renaming it won’t break the link."
            : presetName
            ? <>Nothing assigned yet. <button type="button" onClick={usePreset} disabled={busy} className="font-semibold text-blue-600 underline hover:text-blue-800 disabled:opacity-50">Use the {presetName} preset</button> — creates the card and assigns it in one step.</>
            : "Pick a template to enable previews and sends."}
        </div>

        {/* message — "{ } Insert field" opens the full merge-tag picker */}
        <div className="mt-4">
          <FieldWithTags
            label="Outgoing message"
            multiline
            rows={4}
            value={message}
            onChange={setMessage}
            groups={tagGroups}
          />
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Filled in per customer at send time — any field from the picker works
          {section === "reviews" ? <>, plus <code>[Review Link]</code></> : null}.
        </p>

        {error ? <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

        <div className="mt-4 grid grid-cols-2 gap-2">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <SendButton onClick={save} busy={busy}>Save</SendButton>
        </div>
      </div>
    </div>
  );
}
