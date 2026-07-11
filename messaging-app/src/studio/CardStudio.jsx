import React, { useState, useEffect, useMemo, useCallback } from "react";
import ClientCanvas from "./ClientCanvas.jsx";
import Inspector from "./Inspector.jsx";
import DataSourcesPanel from "./DataSourcesPanel.jsx";
import ConnectionsModal from "./ConnectionsModal.jsx";
import WorkflowModal from "./WorkflowModal.jsx";
import * as api from "./api.js";
import { newLayer, mergeTagGroups, CANVAS_PRESETS } from "./model.js";
import { reviewRequestStarter, starterList } from "@shared/starters.js";

/*
  CardStudio — the Dynamic Card Studio. Replaces the old "Personalized image"
  section. Left = editable canvas; right = inspector. Toolbar on top; sample
  data + server preview below the canvas. Exposes the selected template id via
  onTemplateChange so the page's Send-a-card block can target it.
*/
export default function CardStudio({ onTemplateChange, controller, onStudioState, previewOverride, contactPreviewUrl, contactPreviewLoading }) {
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
  if (controller) controller.current = { loadTemplate, newFromStarter };
  useEffect(() => { onStudioState?.({ templates, currentId }); }, [templates, currentId]);

  // Initial template list.
  useEffect(() => {
    api.listTemplates().then(async (list) => {
      setTemplates(list || []);
      if (list && list.length) await loadTemplate(list[0].id, list);
    }).catch(() => {});
  }, []);

  async function loadTemplate(id, list = templates) {
    try {
      const t = await api.getTemplate(id);
      setTemplate(t);
      setCurrentId(id);
      setSelectedId(null);
      setDirty(false);
      setServerPreview(null);
    } catch {
      showToast("Couldn’t load template");
    }
  }

  /* ---------- edit ops ---------- */
  const patchTemplate = useCallback((patch) => { setTemplate((t) => ({ ...t, ...patch })); setDirty(true); }, []);

  const changeLayer = useCallback((id, patch) => {
    setTemplate((t) => ({ ...t, layers: t.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
    setDirty(true);
  }, []);

  const addLayer = useCallback((type) => {
    const l = newLayer(type);
    setTemplate((t) => ({ ...t, layers: [...t.layers, l] }));
    setSelectedId(l.id);
    setDirty(true);
  }, []);

  const deleteLayer = useCallback((id) => {
    setTemplate((t) => ({ ...t, layers: t.layers.filter((l) => l.id !== id) }));
    setSelectedId((s) => (s === id ? null : s));
    setDirty(true);
  }, []);

  const duplicateLayer = useCallback((id) => {
    setTemplate((t) => {
      const src = t.layers.find((l) => l.id === id);
      if (!src) return t;
      const copy = { ...src, id: "id" + Math.random().toString(36).slice(2), x: src.x + 3, y: src.y + 3 };
      return { ...t, layers: [...t.layers, copy] };
    });
    setDirty(true);
  }, []);

  const reorder = useCallback((id, dir) => {
    setTemplate((t) => {
      const i = t.layers.findIndex((l) => l.id === id);
      const j = dir === "up" ? i + 1 : i - 1;
      if (i < 0 || j < 0 || j >= t.layers.length) return t;
      const layers = [...t.layers];
      [layers[i], layers[j]] = [layers[j], layers[i]];
      return { ...t, layers };
    });
    setDirty(true);
  }, []);

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
    } catch (e) {
      showToast("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  }
  function newFromStarter(build = reviewRequestStarter) {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
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
      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={currentId || ""} onChange={(e) => (e.target.value ? loadTemplate(e.target.value) : newFromStarter())}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">＋ New (Review Request)</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input value={template.name} onChange={(e) => patchTemplate({ name: e.target.value })}
          className="w-44 rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-medium" />
        <select value="" onChange={(e) => { const s = starterList().find((x) => x.id === e.target.value); if (s) newFromStarter(s.build); e.target.value = ""; }}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">New from starter…</option>
          {starterList().map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button type="button" onClick={duplicate} disabled={!currentId} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">Duplicate</button>
        <button type="button" onClick={remove} disabled={!currentId} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">Delete</button>
        <button type="button" onClick={() => setConnectionsOpen(true)} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50">Connections</button>
        <button type="button" onClick={() => setWorkflowOpen(true)} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50">Use in workflow</button>
        <div className="ml-auto flex items-center gap-2">
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
                onChange={changeLayer} onDuplicate={duplicateLayer} onDelete={deleteLayer} />
            )}
            <p className="mt-1 text-center text-[11px] text-gray-400">
              {contactPreviewUrl || contactPreviewLoading
                ? "Real render for the selected contact · clear the contact to edit"
                : "Drag layers · ⌘D duplicate · Delete removes · arrows nudge (⇧ = larger)"}
            </p>
          </div>

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
