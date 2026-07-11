import React, { useState, useEffect, useMemo, useCallback } from "react";
import ClientCanvas from "./ClientCanvas.jsx";
import Inspector from "./Inspector.jsx";
import DataSourcesPanel from "./DataSourcesPanel.jsx";
import ConnectionsModal from "./ConnectionsModal.jsx";
import * as api from "./api.js";
import { newLayer, mergeTagGroups, CANVAS_PRESETS } from "./model.js";
import { extractTemplateBindings } from "@shared/bindings.js";
import { reviewRequestStarter, starterList } from "@shared/starters.js";

/*
  CardStudio — the Dynamic Card Studio. Replaces the old "Personalized image"
  section. Left = editable canvas; right = inspector. Toolbar on top; sample
  data + server preview below the canvas. Exposes the selected template id via
  onTemplateChange so the page's Send-a-card block can target it.
*/
export default function CardStudio({ onTemplateChange, controller, onStudioState }) {
  const [connectionsOpen, setConnectionsOpen] = useState(false);
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
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState([]);

  const groups = useMemo(
    () => mergeTagGroups({ customFields, dataSources: template.dataSources }),
    [customFields, template.dataSources]
  );

  const showToast = (m) => { setToast(m); clearTimeout(showToast._t); showToast._t = setTimeout(() => setToast(null), 2400); };

  useEffect(() => { api.getCustomFields().then(setCustomFields); }, []);
  // Emit the FULL live template (with the saved id) so the page's phone preview
  // mirrors every edit in real time; id drives send routing.
  useEffect(() => { onTemplateChange?.({ ...template, id: currentId }); }, [template, currentId]);

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

  /* ---------- sample data ---------- */
  const setSample = (key, value) => patchTemplate({ sampleData: { ...template.sampleData, [key]: value } });
  const addReferencedFields = () => {
    const refs = extractTemplateBindings(template);
    const next = { ...template.sampleData };
    for (const r of refs) if (!(r in next)) next[r] = "";
    patchTemplate({ sampleData: next });
    showToast("Added referenced fields");
  };
  useEffect(() => {
    if (!contactQuery.trim()) { setContactResults([]); return; }
    const t = setTimeout(() => api.searchContacts(contactQuery.trim()).then(setContactResults), 350);
    return () => clearTimeout(t);
  }, [contactQuery]);
  function fillFromContact(c) {
    const sd = { ...template.sampleData };
    if (c.firstName) sd["contact.first_name"] = c.firstName;
    if (c.lastName) sd["contact.last_name"] = c.lastName;
    if (c.phone) sd["contact.phone"] = c.phone;
    if (c.email) sd["contact.email"] = c.email;
    patchTemplate({ sampleData: sd });
    setContactQuery(""); setContactResults([]);
    showToast(`Loaded ${c.firstName || "contact"}`);
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
      const saved = currentId ? await api.updateTemplate(currentId, body) : await api.createTemplate(body);
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
      const r = await api.renderPreview(template, template.sampleData);
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
        {/* canvas + sample data + server preview */}
        <div>
          <div className="mx-auto max-w-[520px]">
            <ClientCanvas template={template} selectedId={selectedId} onSelect={setSelectedId}
              onChange={changeLayer} onDuplicate={duplicateLayer} onDelete={deleteLayer} />
            <p className="mt-1 text-center text-[11px] text-gray-400">Drag layers · ⌘D duplicate · Delete removes · arrows nudge (⇧ = larger)</p>
          </div>

          <div className="mt-4">
            <DataSourcesPanel template={template} patchTemplate={patchTemplate} groups={groups} showToast={showToast} currentId={currentId} />
          </div>

          {/* sample data */}
          <div className="mt-4 rounded-lg border border-gray-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wide text-gray-400">Sample data (preview values)</span>
              <button type="button" onClick={addReferencedFields} className="text-[11px] font-medium text-green-700 underline">Add referenced fields</button>
            </div>
            <div className="mb-2">
              <input value={contactQuery} onChange={(e) => setContactQuery(e.target.value)} placeholder="Preview with a real contact — search…"
                className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm" />
              {contactResults.length > 0 && (
                <div className="mt-1 max-h-36 overflow-auto rounded-lg border border-gray-200">
                  {contactResults.map((c) => (
                    <button key={c.id} type="button" onClick={() => fillFromContact(c)} className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-gray-50">
                      <span>{[c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone}</span>
                      <span className="text-xs text-gray-400">{c.phone}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(template.sampleData || {}).map(([k, v]) => (
                <label key={k} className="block text-[11px] font-medium text-gray-600">
                  <span className="font-mono text-[10px] text-gray-400">{k}</span>
                  <input value={v} onChange={(e) => setSample(k, e.target.value)} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" />
                </label>
              ))}
            </div>
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
      {toast && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-lg">{toast}</div>}
    </div>
  );
}
