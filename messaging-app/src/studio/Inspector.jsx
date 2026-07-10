import React, { useRef } from "react";
import FieldWithTags from "./MergeTagField.jsx";
import { LAYER_META, FONT_FAMILIES } from "./model.js";

/*
  Inspector — right panel. Top: layer list (add / select / show-hide / z-order).
  Below: property editors for the selected layer, matching the schema. Every
  text-ish input carries the merge-tag picker.
*/
export default function Inspector({ template, selectedId, onSelect, onChangeLayer, onAddLayer, onDeleteLayer, onReorder, groups, onUploadImage }) {
  const layer = template.layers.find((l) => l.id === selectedId);

  return (
    <div className="space-y-4">
      {/* add layer */}
      <div>
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-400">Add layer</div>
        <div className="grid grid-cols-3 gap-1">
          {Object.entries(LAYER_META).map(([type, meta]) => (
            <button key={type} type="button" onClick={() => onAddLayer(type)}
              className="flex items-center justify-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              <span>{meta.icon}</span> {meta.label}
            </button>
          ))}
        </div>
      </div>

      {/* layer list (top-most first) */}
      <div>
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-400">Layers</div>
        <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200">
          {[...template.layers].reverse().map((l) => {
            const idx = template.layers.indexOf(l);
            return (
              <div key={l.id} className={`flex items-center gap-2 px-2 py-1.5 text-sm ${l.id === selectedId ? "bg-green-50" : "bg-white hover:bg-gray-50"}`}>
                <button type="button" onClick={() => onSelect(l.id)} className="flex flex-1 items-center gap-2 text-left">
                  <span className="text-xs text-gray-400">{LAYER_META[l.type]?.icon}</span>
                  <span className="truncate font-medium text-gray-800">{layerLabel(l)}</span>
                </button>
                <button type="button" title="Show/hide" onClick={() => onChangeLayer(l.id, { visible: l.visible === false })} className="text-xs text-gray-400 hover:text-gray-700">
                  {l.visible === false ? "🚫" : "👁"}
                </button>
                <button type="button" title="Bring forward" disabled={idx === template.layers.length - 1} onClick={() => onReorder(l.id, "up")} className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-30">↑</button>
                <button type="button" title="Send back" disabled={idx === 0} onClick={() => onReorder(l.id, "down")} className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-30">↓</button>
                <button type="button" title="Delete" onClick={() => onDeleteLayer(l.id)} className="text-xs text-gray-300 hover:text-red-500">✕</button>
              </div>
            );
          })}
          {template.layers.length === 0 && <div className="px-2 py-3 text-center text-xs text-gray-400">No layers yet</div>}
        </div>
      </div>

      {/* properties */}
      {layer && (
        <div className="space-y-3 rounded-lg border border-gray-200 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-gray-400">{LAYER_META[layer.type]?.label} properties</span>
            <label className="flex items-center gap-1 text-[11px] text-gray-500">
              <input type="checkbox" checked={!!layer.locked} onChange={(e) => onChangeLayer(layer.id, { locked: e.target.checked })} /> Lock
            </label>
          </div>

          <PropsForLayer layer={layer} onChange={(patch) => onChangeLayer(layer.id, patch)} template={template} groups={groups} onUploadImage={onUploadImage} />

          {/* common: position/size */}
          <div className="grid grid-cols-4 gap-2 border-t border-gray-100 pt-3">
            <Num label="X%" value={layer.x} onChange={(v) => onChangeLayer(layer.id, { x: v })} />
            <Num label="Y%" value={layer.y} onChange={(v) => onChangeLayer(layer.id, { y: v })} />
            <Num label="W%" value={layer.width} onChange={(v) => onChangeLayer(layer.id, { width: v })} />
            <Num label="H%" value={layer.height} onChange={(v) => onChangeLayer(layer.id, { height: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Num label="Rotation°" value={layer.rotation || 0} onChange={(v) => onChangeLayer(layer.id, { rotation: v })} />
            <Range label={`Opacity ${Math.round((layer.opacity ?? 1) * 100)}%`} value={layer.opacity ?? 1} min={0} max={1} step={0.05} onChange={(v) => onChangeLayer(layer.id, { opacity: v })} />
          </div>
        </div>
      )}
    </div>
  );
}

function PropsForLayer({ layer, onChange, template, groups, onUploadImage }) {
  const fileRef = useRef(null);
  switch (layer.type) {
    case "image":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">Choose image…</button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onUploadImage(layer.id, e.target.files[0])} />
            {layer.src && <img src={layer.src} alt="" className="h-8 w-8 rounded object-cover" />}
          </div>
          <Seg label="Fit" value={layer.fit} options={[["cover", "Fill"], ["contain", "Whole image"]]} onChange={(v) => onChange({ fit: v })} />
          <Num label="Corner radius (px)" value={layer.cornerRadius || 0} onChange={(v) => onChange({ cornerRadius: v })} />
        </div>
      );
    case "dynamic-image":
      return (
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-gray-700">Data source
            <select value={layer.sourceId} onChange={(e) => onChange({ sourceId: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">— pick a source —</option>
              {(template.dataSources || []).map((ds) => <option key={ds.id} value={ds.id}>{ds.id} ({ds.provider})</option>)}
            </select>
          </label>
          <Seg label="Fit" value={layer.fit} options={[["cover", "Fill"], ["contain", "Whole image"]]} onChange={(v) => onChange({ fit: v })} />
        </div>
      );
    case "text":
      return (
        <div className="space-y-2">
          <FieldWithTags label="Content" value={layer.content} onChange={(v) => onChange({ content: v })} groups={groups} multiline rows={2} />
          <div className="grid grid-cols-2 gap-2">
            <SelectF label="Font" value={layer.fontFamily} options={FONT_FAMILIES} onChange={(v) => onChange({ fontFamily: v })} />
            <Seg label="Weight" value={layer.fontWeight} options={[["regular", "Reg"], ["bold", "Bold"]]} onChange={(v) => onChange({ fontWeight: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Num label="Size (px)" value={layer.fontSize} onChange={(v) => onChange({ fontSize: v })} />
            <Color label="Color" value={layer.color} onChange={(v) => onChange({ color: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Seg label="Align" value={layer.align} options={[["left", "L"], ["center", "C"], ["right", "R"]]} onChange={(v) => onChange({ align: v })} />
            <Num label="Line height" value={layer.lineHeight} step={0.05} onChange={(v) => onChange({ lineHeight: v })} />
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={!!layer.autoFit} onChange={(e) => onChange({ autoFit: e.target.checked })} /> Auto-fit (shrink & wrap to box)
          </label>
        </div>
      );
    case "name-box":
      return (
        <div className="space-y-2">
          <FieldWithTags label="Content" value={layer.content} onChange={(v) => onChange({ content: v })} groups={groups} />
          <div className="grid grid-cols-2 gap-2">
            <Color label="Pill color" value={layer.bgColor} onChange={(v) => onChange({ bgColor: v })} />
            <Color label="Text color" value={layer.textColor} onChange={(v) => onChange({ textColor: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <SelectF label="Font" value={layer.fontFamily} options={FONT_FAMILIES} onChange={(v) => onChange({ fontFamily: v })} />
            <Num label="Size (px)" value={layer.fontSize} onChange={(v) => onChange({ fontSize: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Num label="Padding X" value={layer.paddingX} onChange={(v) => onChange({ paddingX: v })} />
            <Num label="Corner radius" value={layer.cornerRadius} onChange={(v) => onChange({ cornerRadius: v })} />
          </div>
        </div>
      );
    case "shape":
      return (
        <div className="space-y-2">
          <SelectF label="Shape" value={layer.shape} options={["rect", "ellipse", "line"]} onChange={(v) => onChange({ shape: v })} />
          <div className="grid grid-cols-2 gap-2">
            <Color label="Fill" value={layer.fill} onChange={(v) => onChange({ fill: v })} allowAlpha />
            <Num label="Corner radius" value={layer.cornerRadius || 0} onChange={(v) => onChange({ cornerRadius: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Color label="Stroke" value={layer.stroke || "#000000"} onChange={(v) => onChange({ stroke: v })} />
            <Num label="Stroke width" value={layer.strokeWidth || 0} onChange={(v) => onChange({ strokeWidth: v })} />
          </div>
        </div>
      );
    case "badge":
      return (
        <div className="space-y-2">
          <SelectF label="Icon" value={layer.icon || ""} options={["", "star", "phone", "pin", "check", "dollar"]} onChange={(v) => onChange({ icon: v || undefined })} />
          <FieldWithTags label="Text" value={layer.text} onChange={(v) => onChange({ text: v })} groups={groups} />
          <div className="grid grid-cols-2 gap-2">
            <Color label="Chip color" value={layer.bgColor} onChange={(v) => onChange({ bgColor: v })} />
            <Color label="Text color" value={layer.textColor} onChange={(v) => onChange({ textColor: v })} />
          </div>
          <Num label="Size (px)" value={layer.fontSize} onChange={(v) => onChange({ fontSize: v })} />
        </div>
      );
    default:
      return null;
  }
}

/* ---------- small controls ---------- */
function Num({ label, value, onChange, step = 1 }) {
  return (
    <label className="block text-[11px] font-medium text-gray-600">{label}
      <input type="number" step={step} value={value ?? 0} onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 outline-none focus:border-green-500" />
    </label>
  );
}
function Range({ label, value, onChange, min, max, step }) {
  return (
    <label className="block text-[11px] font-medium text-gray-600">{label}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="mt-1 w-full accent-green-600" />
    </label>
  );
}
function Color({ label, value, onChange, allowAlpha }) {
  return (
    <label className="block text-[11px] font-medium text-gray-600">{label}
      <div className="mt-0.5 flex items-center gap-1">
        <input type="color" value={hexOnly(value)} onChange={(e) => onChange(e.target.value)} className="h-8 w-8 shrink-0 cursor-pointer rounded border border-gray-300" />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={allowAlpha ? "rgba()/#hex" : "#hex"}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-900 outline-none focus:border-green-500" />
      </div>
    </label>
  );
}
function SelectF({ label, value, options, onChange }) {
  return (
    <label className="block text-[11px] font-medium text-gray-600">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 outline-none focus:border-green-500">
        {options.map((o) => <option key={o} value={o}>{o || "none"}</option>)}
      </select>
    </label>
  );
}
function Seg({ label, value, options, onChange }) {
  return (
    <div className="text-[11px] font-medium text-gray-600">{label}
      <div className="mt-0.5 grid gap-1 rounded-md border border-gray-200 bg-gray-100 p-0.5" style={{ gridTemplateColumns: `repeat(${options.length},1fr)` }}>
        {options.map(([v, l]) => (
          <button key={v} type="button" onClick={() => onChange(v)} className={`rounded py-1 text-xs font-semibold ${value === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>{l}</button>
        ))}
      </div>
    </div>
  );
}
function hexOnly(v) {
  const m = String(v || "").match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  return m ? v : "#000000";
}
function layerLabel(l) {
  if (l.type === "text") return l.content?.slice(0, 24) || "Text";
  if (l.type === "name-box") return "Name: " + (l.content?.slice(0, 18) || "");
  if (l.type === "badge") return "Badge: " + (l.text?.slice(0, 16) || l.icon || "");
  if (l.type === "shape") return l.shape;
  if (l.type === "image") return "Image";
  if (l.type === "dynamic-image") return "Dynamic: " + (l.sourceId || "?");
  return l.type;
}
