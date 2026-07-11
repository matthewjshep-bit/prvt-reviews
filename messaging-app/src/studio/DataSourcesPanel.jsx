import React, { useEffect, useState } from "react";
import FieldWithTags from "./MergeTagField.jsx";
import { newLayer } from "./model.js";
import * as api from "./api.js";

/*
  DataSourcesPanel — sits above the layer list. Lists the template's data
  sources, adds new ones from the provider catalog, renders each provider's
  config form from its serialized zod schema, maps declared inputs to bindings,
  and runs the per-source Test (discovered keys + thumbnail flow).
*/
export default function DataSourcesPanel({ template, patchTemplate, groups, showToast, currentId }) {
  const [catalog, setCatalog] = useState([]);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(null);

  useEffect(() => { api.getProviders().then(setCatalog); }, []);

  const sources = template.dataSources || [];
  const setSources = (next) => patchTemplate({ dataSources: next });
  const updateSource = (id, patch) => setSources(sources.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  function addSource(provider) {
    const base = provider.id.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "src";
    let id = base, n = 1;
    while (sources.some((s) => s.id === id)) id = `${base}${++n}`;
    const options = {};
    for (const f of provider.options || []) if (f.default !== undefined) options[f.key] = f.default;
    setSources([...sources, { id, provider: provider.id, inputs: {}, options, connectionId: "", discoveredKeys: [], thumbnailUrl: "" }]);
    setAdding(false);
  }

  // Insert a full-canvas dynamic-image layer bound to this source, at the bottom
  // (so it's the card background). Carries the source's tested thumbnail so the
  // client preview shows the image immediately.
  function useAsBackground(ds) {
    const layer = newLayer("dynamic-image", { sourceId: ds.id, thumbnailUrl: ds.thumbnailUrl || "" });
    patchTemplate({ layers: [layer, ...template.layers] });
    showToast("Added as background image");
  }

  async function runTest(ds) {
    const provider = catalog.find((p) => p.id === ds.provider);
    setTesting(ds.id);
    try {
      const out = await api.testProvider(ds.provider, {
        inputs: ds.inputs, options: ds.options, sampleData: template.sampleData,
        connectionId: ds.connectionId || undefined, sourceId: ds.id, templateId: currentId || undefined,
      });
      if (!out.ok) { showToast(`Test failed: ${out.error}`); return; }
      // Persist discovered keys + thumbnail on the source, and push the thumbnail
      // onto any dynamic-image layer bound to this source (for the live preview).
      patchTemplate({
        dataSources: sources.map((s) =>
          s.id === ds.id ? { ...s, discoveredKeys: out.keys || [], thumbnailUrl: out.imageUrl || s.thumbnailUrl || "" } : s
        ),
        layers: out.imageUrl
          ? template.layers.map((l) =>
              l.type === "dynamic-image" && l.sourceId === ds.id ? { ...l, thumbnailUrl: out.imageUrl } : l
            )
          : template.layers,
      });
      showToast(`Test OK — ${(out.keys || []).length} field(s)`);
    } catch (e) {
      showToast("Test error: " + e.message);
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-gray-400">Data sources</span>
        <button type="button" onClick={() => setAdding((a) => !a)} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
          + Add data source
        </button>
      </div>

      {adding && (
        <div className="mb-3 grid gap-1 rounded-lg border border-gray-200 bg-gray-50 p-2">
          {catalog.length === 0 && <div className="text-xs text-gray-400">No providers available</div>}
          {catalog.map((p) => (
            <button key={p.id} type="button" onClick={() => addSource(p)} className="rounded-md bg-white px-2 py-1.5 text-left text-xs hover:bg-green-50">
              <span className="font-semibold text-gray-800">{p.name}</span> <span className="text-gray-400">· {p.kind}</span>
              <div className="text-[11px] text-gray-500">{p.description}</div>
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {sources.map((ds) => {
          const provider = catalog.find((p) => p.id === ds.provider);
          const producesImage = provider?.kind === "image" || provider?.kind === "both";
          const bound = template.layers.some((l) => l.type === "dynamic-image" && l.sourceId === ds.id);
          return (
            <div key={ds.id} className="rounded-lg border border-gray-200 p-2">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-xs text-gray-500">data.</span>
                <input value={ds.id} onChange={(e) => updateSource(ds.id, { id: e.target.value.replace(/[^a-z0-9_]/gi, "") })}
                  className="w-24 rounded border border-gray-300 px-1.5 py-0.5 text-xs font-mono" />
                <span className="text-xs text-gray-400">{provider?.name || ds.provider}</span>
                <div className="ml-auto flex gap-1">
                  {producesImage && (bound ? (
                    <span className="rounded border border-green-200 bg-green-50 px-2 py-1 text-[11px] font-semibold text-green-700">✓ on card</span>
                  ) : (
                    <button type="button" onClick={() => useAsBackground(ds)} className="rounded border border-gray-300 px-2 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50">Use as background</button>
                  ))}
                  <button type="button" onClick={() => runTest(ds)} disabled={testing === ds.id} className="rounded bg-gray-900 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50">
                    {testing === ds.id ? "Testing…" : "Test"}
                  </button>
                  <button type="button" onClick={() => setSources(sources.filter((s) => s.id !== ds.id))} className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-500">Remove</button>
                </div>
              </div>

              {/* declared inputs → binding expressions */}
              {(provider?.inputs || []).length > 0 && (
                <div className="mb-2 space-y-1">
                  {provider.inputs.map((inp) => (
                    <FieldWithTags key={inp.key} label={`${inp.label || inp.key}${inp.required ? " *" : ""}`}
                      value={ds.inputs[inp.key] || ""} groups={groups}
                      onChange={(v) => updateSource(ds.id, { inputs: { ...ds.inputs, [inp.key]: v } })} />
                  ))}
                </div>
              )}

              {/* provider options form (from serialized schema) */}
              <div className="space-y-1.5">
                {(provider?.options || []).map((f) => (
                  <OptionField key={f.key} field={f} value={ds.options[f.key]} groups={groups}
                    onChange={(v) => updateSource(ds.id, { options: { ...ds.options, [f.key]: v } })} />
                ))}
              </div>

              {/* discovered keys / thumbnail */}
              {(ds.discoveredKeys?.length || ds.thumbnailUrl) && (
                <div className="mt-2 rounded bg-gray-50 p-2">
                  {ds.thumbnailUrl && <img src={ds.thumbnailUrl} alt="" className="mb-1 max-h-24 rounded" />}
                  {ds.discoveredKeys?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {ds.discoveredKeys.map((k) => (
                        <span key={k} className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-green-700 ring-1 ring-green-200">data.{ds.id}.{k}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {sources.length === 0 && <div className="text-center text-xs text-gray-400">No data sources. Add one to pull live data or images into the card.</div>}
      </div>
    </div>
  );
}

function OptionField({ field, value, onChange, groups }) {
  if (field.type === "toggle")
    return <label className="flex items-center gap-2 text-xs text-gray-700"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {field.label}</label>;
  if (field.type === "select")
    return (
      <label className="block text-[11px] font-medium text-gray-600">{field.label}
        <select value={value ?? field.default ?? ""} onChange={(e) => onChange(e.target.value)} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm">
          {(field.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
    );
  if (field.type === "number")
    return (
      <label className="block text-[11px] font-medium text-gray-600">{field.label}
        <input type="number" value={value ?? ""} onChange={(e) => onChange(parseFloat(e.target.value))} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" />
      </label>
    );
  if (field.type === "color")
    return (
      <label className="block text-[11px] font-medium text-gray-600">{field.label}
        <input type="color" value={value || "#000000"} onChange={(e) => onChange(e.target.value)} className="mt-0.5 h-8 w-full cursor-pointer rounded border border-gray-300" />
      </label>
    );
  if (field.type === "list")
    return <ListField field={field} value={value || []} onChange={onChange} />;
  // text (with merge-tag picker so bindings can be inserted into URLs/bodies)
  return (
    <FieldWithTags label={field.label} value={value ?? ""} groups={groups} onChange={onChange} multiline={field.key === "bodyTemplate"} />
  );
}

function ListField({ field, value, onChange }) {
  const fields = field.item?.fields || [{ key: "value", label: "Value" }];
  const add = () => onChange([...value, Object.fromEntries(fields.map((f) => [f.key, ""]))]);
  const set = (i, k, v) => onChange(value.map((row, j) => (j === i ? { ...row, [k]: v } : row)));
  const rm = (i) => onChange(value.filter((_, j) => j !== i));
  return (
    <div className="text-[11px] font-medium text-gray-600">
      <div className="mb-1 flex items-center justify-between">{field.label}
        <button type="button" onClick={add} className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px]">+ add</button>
      </div>
      {value.map((row, i) => (
        <div key={i} className="mb-1 flex gap-1">
          {fields.map((f) => (
            <input key={f.key} value={row[f.key] || ""} placeholder={f.label} onChange={(e) => set(i, f.key, e.target.value)}
              className="w-full rounded border border-gray-300 px-1.5 py-1 font-mono text-[11px]" />
          ))}
          <button type="button" onClick={() => rm(i)} className="px-1 text-gray-400">✕</button>
        </div>
      ))}
    </div>
  );
}
