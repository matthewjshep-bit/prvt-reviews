import React, { useState, useEffect, useMemo, useCallback } from "react";
import ClientCanvas from "./ClientCanvas.jsx";
import Inspector from "./Inspector.jsx";
import DataSourcesPanel from "./DataSourcesPanel.jsx";
import CardFieldsPanel from "./CardFieldsPanel.jsx";
import ConnectionsModal from "./ConnectionsModal.jsx";
import WorkflowModal from "./WorkflowModal.jsx";
import * as api from "./api.js";
import FieldWithTags from "./MergeTagField.jsx";
import { getHomeConfig, saveSectionConfig } from "../home/api.js";
import { newLayer, mergeTagGroups, CANVAS_PRESETS } from "./model.js";
import { reviewRequestStarter, starterList } from "@shared/starters.js";

// Home sections a template can be assigned to (mirrors the broker's SECTIONS).
const HOME_SECTIONS = { quotes: "Quotes", reviews: "Reviews", winback: "Win-back", offers: "Offers" };

// Draft message templates — starting points for the card's outgoing text.
const MESSAGE_IDEAS = [
  { label: "Quote follow-up",
    text: "Hi {{contact.first_name}}, {{loc.owner_first_name}} here from {{loc.business_name}} — your quote is attached, good through {{contact.custom.quote_expiry}}. Want me to hold your spot on the schedule?" },
  { label: "Quote expiring soon",
    text: "{{contact.first_name}}, quick heads up — your {{loc.business_name}} quote expires soon. Reply YES and I'll lock in your price and get you on the calendar." },
  { label: "Review ask",
    text: "{{contact.first_name}}, thanks for trusting {{loc.business_name}}! If the crew earned it, a quick Google review helps us a ton: [Review Link]" },
  { label: "Win-back / check-in",
    text: "Hi {{contact.first_name}}, {{loc.owner_first_name}} from {{loc.business_name}} — it's been a while since your last service and it's about due again. Want me to pencil you in at your returning-customer rate?" },
  { label: "Offer / better terms",
    text: "{{contact.first_name}} — your pricing just changed: {{data.tier.rate}} and {{data.tier.down}} down, locked for 90 days. Got anything in the works?" },
  { label: "We looked at your website",
    text: "Hi {{contact.first_name}}, we took a look at {{contact.website}} — got a couple of ideas that could bring you more customers. Want me to send them over?" },
  { label: "Simple intro",
    text: "Hi {{contact.first_name}}, {{loc.owner_first_name}} from {{loc.business_name}} here — sending this over so you have us in your texts. Reply anytime, a real person answers." },
];

// "⋯" more-options dropdown for the flow toolbar. items: {label, onClick,
// disabled?, danger?} | {header} | {divider}.
function MoreMenu({ items }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="More options"
        className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-bold text-gray-600 hover:bg-gray-50"
      >
        ⋯
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
            {items.map((it, i) =>
              it.divider ? (
                <div key={i} className="my-1 border-t border-gray-100" />
              ) : it.header ? (
                <div key={i} className="px-3 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-wide text-gray-400">{it.header}</div>
              ) : (
                <button
                  key={i}
                  type="button"
                  disabled={it.disabled}
                  onClick={() => { setOpen(false); it.onClick(); }}
                  className={`block w-full px-3 py-1.5 text-left text-sm disabled:opacity-40 ${
                    it.danger ? "text-red-600 hover:bg-red-50" : "text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {it.label}
                </button>
              )
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/*
  CardStudio — the Dynamic Card Studio. Replaces the old "Personalized image"
  section. Left = editable canvas; right = inspector. Toolbar on top; sample
  data + server preview below the canvas. Exposes the selected template id via
  onTemplateChange so the page's Send-a-card block can target it.
*/
export default function CardStudio({ onTemplateChange, controller, onStudioState, previewOverride, contactPreviewUrl, contactPreviewLoading, flowMode = false, onSaved }) {
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const locationId = api.getLocationId();
  const [templates, setTemplates] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [template, setTemplate] = useState(() => reviewRequestStarter({ locationId }));
  const [selectedId, setSelectedId] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customFields, setCustomFields] = useState([]);
  const [serverPreview, setServerPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [toast, setToast] = useState(null);

  const groups = useMemo(
    () => mergeTagGroups({ customFields, dataSources: template.dataSources }),
    [customFields, template.dataSources]
  );

  // Effective template for PREVIEW ONLY: the selected contact's real fields
  // (previewOverride) layered over the template's baked-in sample data. Editing
  // and saving always use `template` (the override is never persisted).
  const effTemplate = useMemo(
    () =>
      previewOverride && Object.keys(previewOverride).length
        ? { ...template, sampleData: { ...template.sampleData, ...previewOverride } }
        : template,
    [template, previewOverride]
  );

  const showToast = (m) => { setToast(m); clearTimeout(showToast._t); showToast._t = setTimeout(() => setToast(null), 2400); };

  useEffect(() => { api.getCustomFields().then(setCustomFields); }, []);
  // Emit the FULL live template (with the saved id) so the page's phone preview
  // mirrors every edit in real time; id drives send routing.
  useEffect(() => { onTemplateChange?.({ ...effTemplate, id: currentId }); }, [effTemplate, currentId]);

  // Expose an imperative controller + template list so a template picker can
  // live outside the studio (e.g. the page's left column).
  useEffect(() => { onStudioState?.({ templates, currentId, dirty }); }, [templates, currentId, dirty]);

  // Which Home sections use which template (drives the "Used for…" ✓ marks).
  const [assignments, setAssignments] = useState({});
  useEffect(() => {
    getHomeConfig().then((c) => setAssignments(c.assignments || {})).catch(() => {});
  }, []);

  // Initial template list. A ?template=<id> deep link (from a Home section's
  // "Edit design" button) opens that template instead of the most recent one.
  useEffect(() => {
    api.listTemplates().then(async (list) => {
      setTemplates(list || []);
      let wanted = null;
      try { wanted = new URLSearchParams(window.location.search).get("template"); } catch { /* ignore */ }
      const hit = wanted && (list || []).find((t) => t.id === wanted);
      if (hit) await loadTemplate(hit.id, list);
      else if (list && list.length) await loadTemplate(list[0].id, list);
    }).catch(() => {});
  }, []);

  async function assignToSection(sectionKey) {
    if (!currentId) return;
    try {
      await saveSectionConfig(sectionKey, { templateId: currentId });
      setAssignments((a) => ({ ...a, [sectionKey]: currentId }));
      showToast(`This card now sends for ${HOME_SECTIONS[sectionKey]}`);
    } catch (e) {
      showToast("Couldn’t assign: " + e.message);
    }
  }

  async function loadTemplate(id, list = templates) {
    try {
      const t = await api.getTemplate(id);
      resetHistory();
      setTemplate(t);
      setCurrentId(id);
      setSelectedId(null);
      setDirty(false);
      setServerPreview(null);
    } catch {
      showToast("Couldn’t load template");
    }
  }

  /* ---------- undo / redo ---------- */
  // Snapshot the doc before every recorded mutation. Rapid edits (typing,
  // drags) within 800ms coalesce into one step. All mutations are immutable
  // spreads, so storing references is safe.
  const historyRef = useRef({ past: [], future: [], lastPush: 0 });
  const [historyTick, setHistoryTick] = useState(0); // re-render for button states
  const resetHistory = () => { historyRef.current = { past: [], future: [], lastPush: 0 }; setHistoryTick((n) => n + 1); };
  const record = useCallback((updater) => {
    setTemplate((t) => {
      const h = historyRef.current;
      const now = Date.now();
      if (now - h.lastPush > 800) {
        h.past.push(t);
        if (h.past.length > 50) h.past.shift();
        h.future = [];
        h.lastPush = now;
        setHistoryTick((n) => n + 1);
      }
      return typeof updater === "function" ? updater(t) : updater;
    });
    setDirty(true);
  }, []);
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return;
    setTemplate((t) => {
      const prev = h.past.pop();
      h.future.push(t);
      h.lastPush = 0; // next edit starts a fresh step
      setHistoryTick((n) => n + 1);
      return prev;
    });
    setDirty(true);
    setSelectedId(null);
  }, []);
  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return;
    setTemplate((t) => {
      const next = h.future.pop();
      h.past.push(t);
      h.lastPush = 0;
      setHistoryTick((n) => n + 1);
      return next;
    });
    setDirty(true);
    setSelectedId(null);
  }, []);
  // ⌘Z / ⌘⇧Z anywhere in the editor, except while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const el = e.target;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  /* ---------- edit ops (all history-recorded) ---------- */
  const patchTemplate = useCallback((patch) => { record((t) => ({ ...t, ...patch })); }, [record]);

  const changeLayer = useCallback((id, patch) => {
    record((t) => ({ ...t, layers: t.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  }, [record]);

  const addLayer = useCallback((type, extra) => {
    const l = newLayer(type, extra);
    record((t) => ({ ...t, layers: [...t.layers, l] }));
    setSelectedId(l.id);
  }, [record]);

  // A field chip dropped on the canvas at (x%, y%) → positioned bound text layer.
  const clampPct = (v, max = 90) => Math.max(0, Math.min(max, Math.round(v * 10) / 10));
  const dropToken = useCallback((token, x, y) => {
    addLayer("text", {
      x: clampPct(x - 15, 70),
      y: clampPct(y - 4, 92),
      width: 40,
      content: `{{${token}}}`,
      color: "#ffffff",
    });
  }, [addLayer]);

  // Update the cached preview image for a data source (and its bound layers)
  // WITHOUT marking the template dirty — it's a preview cache, not an edit.
  // Functional update so an in-flight fetch can't clobber concurrent edits.
  const applySourceThumbnail = useCallback((sourceId, url) => {
    setTemplate((t) => ({
      ...t,
      dataSources: (t.dataSources || []).map((d) => (d.id === sourceId ? { ...d, thumbnailUrl: url } : d)),
      layers: (t.layers || []).map((l) =>
        l.type === "dynamic-image" && l.sourceId === sourceId ? { ...l, thumbnailUrl: url } : l
      ),
    }));
  }, []);

  // Imperative surface for the flow shell / preview rail. Assigned AFTER the
  // callbacks above are initialized (referencing them earlier is a TDZ crash).
  if (controller) {
    controller.current = {
      loadTemplate,
      newFromStarter,
      save,
      patchTemplate,
      applySourceThumbnail,
      // Add a bound text layer at a sensible default spot (panel click-to-add).
      addField: (token) => addLayer("text", { x: 20, y: 42, width: 60, content: `{{${token}}}`, color: "#ffffff" }),
      refreshCustomFields: () => api.getCustomFields().then(setCustomFields),
    };
  }

  const deleteLayer = useCallback((id) => {
    record((t) => ({ ...t, layers: t.layers.filter((l) => l.id !== id) }));
    setSelectedId((s) => (s === id ? null : s));
  }, [record]);

  const duplicateLayer = useCallback((id) => {
    record((t) => {
      const src = t.layers.find((l) => l.id === id);
      if (!src) return t;
      const copy = { ...src, id: "id" + Math.random().toString(36).slice(2), x: src.x + 3, y: src.y + 3 };
      return { ...t, layers: [...t.layers, copy] };
    });
  }, [record]);

  const reorder = useCallback((id, dir) => {
    record((t) => {
      const i = t.layers.findIndex((l) => l.id === id);
      const j = dir === "up" ? i + 1 : i - 1;
      if (i < 0 || j < 0 || j >= t.layers.length) return t;
      const layers = [...t.layers];
      [layers[i], layers[j]] = [layers[j], layers[i]];
      return { ...t, layers };
    });
  }, [record]);

  async function uploadImage(id, file) {
    try {
      changeLayer(id, { src: URL.createObjectURL(file) }); // instant local preview
      const url = await api.uploadAsset(file);
      changeLayer(id, { src: url });
      showToast("Image uploaded");
    } catch {
      showToast("Upload failed (needs R2 in production)");
    }
  }

  /* ---------- template ops ---------- */
  // Strip transient editor-only fields (underscore-prefixed) before persisting,
  // so they never trip the broker's strict schema validation.
  function forSave(t) {
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));
    return {
      ...clean(t),
      dataSources: (t.dataSources || []).map(clean),
      layers: (t.layers || []).map(clean),
    };
  }

  async function save() {
    setSaving(true);
    try {
      const body = forSave(template);
      let saved;
      if (currentId) {
        try {
          saved = await api.updateTemplate(currentId, body);
        } catch (e) {
          // Stale/missing id (store reset, or editing a preset) → save as a NEW
          // template instead of failing.
          if (/not found/i.test(e.message || "")) saved = await api.createTemplate(body);
          else throw e;
        }
      } else {
        saved = await api.createTemplate(body);
      }
      setTemplate(saved);
      setCurrentId(saved.id);
      setDirty(false);
      setTemplates(await api.listTemplates());
      showToast(`Saved · v${saved.version}`);
      onSaved?.(saved);
    } catch (e) {
      showToast("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  }
  function newFromStarter(build = reviewRequestStarter) {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    resetHistory();
    setTemplate(build({ locationId }));
    setCurrentId(null); setSelectedId(null); setDirty(true); setServerPreview(null);
  }
  async function duplicate() {
    const { id, version, createdAt, updatedAt, ...rest } = template;
    const copy = await api.createTemplate(forSave({ ...rest, name: rest.name + " copy" }));
    setTemplates(await api.listTemplates());
    await loadTemplate(copy.id);
    showToast("Duplicated");
  }
  async function remove() {
    if (!currentId || !window.confirm("Delete this template?")) return;
    await api.deleteTemplate(currentId);
    const list = await api.listTemplates();
    setTemplates(list);
    if (list.length) await loadTemplate(list[0].id, list);
    else newFromStarter();
    showToast("Deleted");
  }

  async function runServerPreview() {
    setPreviewing(true);
    try {
      const r = await api.renderPreview(effTemplate, effTemplate.sampleData);
      setServerPreview(r);
    } catch {
      showToast("Server preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  const preset = (p) => patchTemplate({ canvas: { width: p.width, height: p.height } });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      {/* toolbar — flowMode keeps it minimal: hot-swap switcher + name + ⋯ menu.
          The legacy (non-flow) editor keeps all controls inline. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {flowMode ? (
          // Live hot-swap between saved cards (with a discard guard when dirty).
          <select
            value={currentId || ""}
            onChange={(e) => {
              const id = e.target.value;
              if (!id || id === currentId) return;
              if (dirty && !window.confirm("Discard unsaved changes?")) return;
              loadTemplate(id);
            }}
            className="max-w-[240px] rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-medium"
            title="Switch card"
          >
            {!currentId ? <option value="">Unsaved draft</option> : null}
            {templates.map((t) => {
              const sec = Object.keys(HOME_SECTIONS).find((k) => assignments[k] === t.id);
              return (
                <option key={t.id} value={t.id}>
                  {t.name}{sec ? ` · ${HOME_SECTIONS[sec]}` : ""}
                </option>
              );
            })}
          </select>
        ) : (
          <select value={currentId || ""} onChange={(e) => (e.target.value ? loadTemplate(e.target.value) : newFromStarter())}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">＋ New (Review Request)</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <input value={template.name} onChange={(e) => patchTemplate({ name: e.target.value })}
          className={`rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-medium ${flowMode ? "w-48" : "w-44"}`} />
        {!flowMode && (
          <select value="" onChange={(e) => { const s = starterList().find((x) => x.id === e.target.value); if (s) newFromStarter(s.build); e.target.value = ""; }}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">New from starter…</option>
            {starterList().map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {flowMode ? (
          <MoreMenu
            items={[
              { label: "Duplicate", onClick: duplicate, disabled: !currentId },
              { label: "Connections", onClick: () => setConnectionsOpen(true) },
              { label: "Use in workflow", onClick: () => setWorkflowOpen(true) },
              { header: "Used for" },
              ...Object.entries(HOME_SECTIONS).map(([k, label]) => ({
                label: assignments[k] === currentId ? `✓ ${label}` : label,
                onClick: () => assignToSection(k),
                disabled: !currentId,
              })),
              { divider: true },
              { label: "Delete card…", onClick: remove, disabled: !currentId, danger: true },
            ]}
          />
        ) : (
          <>
            <button type="button" onClick={duplicate} disabled={!currentId} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">Duplicate</button>
            <button type="button" onClick={remove} disabled={!currentId} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">Delete</button>
            <button type="button" onClick={() => setConnectionsOpen(true)} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50">Connections</button>
            <select
              value=""
              disabled={!currentId}
              title={currentId ? "Send this card from a Home section" : "Save the template first"}
              onChange={(e) => { const s = e.target.value; e.target.value = ""; if (s) assignToSection(s); }}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm disabled:opacity-40"
            >
              <option value="">Used for…</option>
              {Object.entries(HOME_SECTIONS).map(([k, label]) => (
                <option key={k} value={k}>
                  {assignments[k] === currentId ? `✓ ${label}` : label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setWorkflowOpen(true)} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50">Use in workflow</button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-gray-300">
            <button
              type="button"
              onClick={undo}
              disabled={!historyRef.current.past.length}
              title="Undo (⌘Z)"
              className="px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-30"
            >
              ↺
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!historyRef.current.future.length}
              title="Redo (⌘⇧Z)"
              className="border-l border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-30"
            >
              ↻
            </button>
          </div>
          <select onChange={(e) => { const p = CANVAS_PRESETS.find((x) => x.id === e.target.value); if (p) preset(p); }}
            value={CANVAS_PRESETS.find((p) => p.width === template.canvas.width && p.height === template.canvas.height)?.id || ""}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">Canvas…</option>
            {CANVAS_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <button type="button" onClick={runServerPreview} disabled={previewing} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
            {previewing ? "Rendering…" : "Server preview"}
          </button>
          <button type="button" onClick={save} disabled={saving || (!dirty && currentId)} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: "#16a34a" }}>
            {saving ? "Saving…" : dirty || !currentId ? "Save" : "Saved"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* canvas + data sources + server preview */}
        <div>
          <div className="mx-auto max-w-[520px]">
            {contactPreviewUrl || contactPreviewLoading ? (
              // Real per-contact render (accurate). Clear the contact to edit.
              <div className="relative overflow-hidden rounded-xl bg-black">
                {contactPreviewUrl ? (
                  <img src={contactPreviewUrl} alt="Contact preview" className="w-full" />
                ) : (
                  <div style={{ aspectRatio: `${effTemplate.canvas.width} / ${effTemplate.canvas.height}` }} />
                )}
                <div className="absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-[11px] font-medium text-white">
                  {contactPreviewLoading ? "Rendering contact…" : "Previewing a contact — clear to edit"}
                </div>
              </div>
            ) : (
              <ClientCanvas template={effTemplate} selectedId={selectedId} onSelect={setSelectedId}
                onChange={changeLayer} onDuplicate={duplicateLayer} onDelete={deleteLayer} onDropToken={dropToken} />
            )}
            <p className="mt-1 text-center text-[11px] text-gray-400">
              {contactPreviewUrl || contactPreviewLoading
                ? "Real render for the selected contact · clear the contact to edit"
                : "Drag layers · ⌘D duplicate · Delete removes · arrows nudge (⇧ = larger)"}
            </p>
          </div>

          {/* The message ships WITH the card — edited here, saved by Save. */}
          {flowMode ? (
            <div className="mt-4 rounded-lg border border-gray-200 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-gray-400">Message</span>
                <div className="flex items-center gap-2">
                  <select
                    value=""
                    onChange={(e) => {
                      const idea = MESSAGE_IDEAS.find((m) => m.label === e.target.value);
                      e.target.value = "";
                      if (!idea) return;
                      if (template.message?.trim() && !window.confirm("Replace the current message with this draft?")) return;
                      patchTemplate({ message: idea.text });
                    }}
                    className="rounded-md border border-gray-200 px-1.5 py-1 text-[11px] text-gray-600"
                  >
                    <option value="">💡 Start from a draft…</option>
                    {MESSAGE_IDEAS.map((m) => <option key={m.label} value={m.label}>{m.label}</option>)}
                  </select>
                  <span className="text-[11px] text-gray-400">saved with this card</span>
                </div>
              </div>
              <FieldWithTags
                multiline
                rows={3}
                value={template.message || ""}
                onChange={(v) => patchTemplate({ message: v })}
                groups={groups}
                placeholder="Hey {{contact.first_name}}, …"
              />
            </div>
          ) : null}

          {/* In the flow, field status lives in the left rail's "On this card"
              group — the standalone panel is legacy-editor only. */}
          {!flowMode && (
            <div className="mt-4">
              <CardFieldsPanel
                template={template}
                customFields={customFields}
                patchTemplate={patchTemplate}
                showToast={showToast}
                onCreateField={async (name, dataType) => {
                  const r = await api.createCustomField({ name, dataType });
                  setCustomFields(await api.getCustomFields());
                  return r;
                }}
              />
            </div>
          )}

          <div className="mt-4">
            <DataSourcesPanel template={template} patchTemplate={patchTemplate} groups={groups} showToast={showToast} currentId={currentId} />
          </div>

          {serverPreview && (
            <div className="mt-4 rounded-lg border border-gray-200 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">Server preview (actual render)</div>
              <img src={serverPreview.url} alt="Server render" className="mx-auto max-w-[320px] rounded-lg" />
              {serverPreview.missing?.length > 0 && (
                <p className="mt-2 text-center text-[11px] text-amber-600">Unresolved: {serverPreview.missing.join(", ")}</p>
              )}
            </div>
          )}
        </div>

        {/* inspector */}
        <Inspector template={template} selectedId={selectedId} onSelect={setSelectedId}
          onChangeLayer={changeLayer} onAddLayer={addLayer} onDeleteLayer={deleteLayer}
          onReorder={reorder} groups={groups} onUploadImage={uploadImage} />
      </div>

      {connectionsOpen && <ConnectionsModal onClose={() => setConnectionsOpen(false)} providers={[]} />}
      {workflowOpen && <WorkflowModal onClose={() => setWorkflowOpen(false)} templateName={template.name} templateId={currentId} saved={Boolean(currentId)} />}
      {toast && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-lg">{toast}</div>}
    </div>
  );
}
