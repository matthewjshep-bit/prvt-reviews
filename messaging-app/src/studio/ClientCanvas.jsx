import React, { useRef, useState, useEffect, useCallback } from "react";
import { resolveBindings, flatToContext } from "@shared/bindings.js";
import { LayerBody } from "./TemplatePreview.jsx";

/*
  ClientCanvas — the editable preview. Renders the template as absolute-
  positioned divs (approximate, NOT pixel-identical to Sharp — the "Server
  preview" button shows the real render). Provides free 2D dragging, 8-handle
  resize, snapping to canvas center/edges + other layers' edges (magenta
  guides), and Mac keyboard shortcuts.
*/

const SNAP = 1; // percent snap threshold
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export default function ClientCanvas({ template, selectedId, onSelect, onChange, onDuplicate, onDelete }) {
  const canvasRef = useRef(null);
  const [cw, setCw] = useState(1);
  const [guides, setGuides] = useState({ v: [], h: [] });
  const context = flatToContext(template.sampleData || {});

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCw(el.clientWidth));
    ro.observe(el);
    setCw(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scale = cw / template.canvas.width;
  const fpx = (px) => Math.max(1, px * scale);

  /* ---------- snapping ---------- */
  const computeSnap = useCallback(
    (layer, nx, ny) => {
      const w = layer.width, h = layer.height;
      const others = template.layers.filter((l) => l.id !== layer.id && l.visible !== false);
      const vT = [0, 50, 100], hT = [0, 50, 100];
      others.forEach((l) => {
        vT.push(l.x, l.x + l.width / 2, l.x + l.width);
        hT.push(l.y, l.y + l.height / 2, l.y + l.height);
      });
      const selfV = [nx, nx + w / 2, nx + w];
      const selfH = [ny, ny + h / 2, ny + h];
      let dx = 0, bx = SNAP;
      selfV.forEach((sv) => vT.forEach((t) => { const d = t - sv; if (Math.abs(d) < bx) { bx = Math.abs(d); dx = d; } }));
      let dy = 0, by = SNAP;
      selfH.forEach((sh) => hT.forEach((t) => { const d = t - sh; if (Math.abs(d) < by) { by = Math.abs(d); dy = d; } }));
      const fx = nx + dx, fy = ny + dy;
      const gv = vT.filter((t) => [fx, fx + w / 2, fx + w].some((s) => Math.abs(s - t) < 0.25));
      const gh = hT.filter((t) => [fy, fy + h / 2, fy + h].some((s) => Math.abs(s - t) < 0.25));
      return { x: fx, y: fy, guides: { v: [...new Set(gv)], h: [...new Set(gh)] } };
    },
    [template.layers]
  );

  /* ---------- drag ---------- */
  function startDrag(e, layer) {
    if (layer.locked) return;
    e.stopPropagation();
    onSelect(layer.id);
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const o = { x: layer.x, y: layer.y };
    let axis = null;
    const move = (ev) => {
      let dxp = ((ev.clientX - sx) / rect.width) * 100;
      let dyp = ((ev.clientY - sy) / rect.height) * 100;
      if (ev.shiftKey) {
        if (!axis) axis = Math.abs(dxp) > Math.abs(dyp) ? "x" : "y";
        if (axis === "x") dyp = 0; else dxp = 0;
      } else axis = null;
      const s = computeSnap(layer, o.x + dxp, o.y + dyp);
      onChange(layer.id, { x: round(s.x), y: round(s.y) });
      setGuides(s.guides);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGuides({ v: [], h: [] });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* ---------- resize ---------- */
  function startResize(e, layer, hnd) {
    e.stopPropagation();
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const o = { x: layer.x, y: layer.y, w: layer.width, h: layer.height };
    const move = (ev) => {
      const dxp = ((ev.clientX - sx) / rect.width) * 100;
      const dyp = ((ev.clientY - sy) / rect.height) * 100;
      let { x, y, w, h } = o;
      if (hnd.includes("e")) w = Math.max(2, o.w + dxp);
      if (hnd.includes("s")) h = Math.max(2, o.h + dyp);
      if (hnd.includes("w")) { w = Math.max(2, o.w - dxp); x = o.x + (o.w - w); }
      if (hnd.includes("n")) { h = Math.max(2, o.h - dyp); y = o.y + (o.h - h); }
      onChange(layer.id, { x: round(x), y: round(y), width: round(w), height: round(h) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* ---------- keyboard ---------- */
  function onKeyDown(e) {
    if (!selectedId) return;
    const layer = template.layers.find((l) => l.id === selectedId);
    if (!layer) return;
    const step = e.shiftKey ? 2 : 0.5;
    if (e.key === "ArrowLeft") { onChange(selectedId, { x: round(layer.x - step) }); e.preventDefault(); }
    else if (e.key === "ArrowRight") { onChange(selectedId, { x: round(layer.x + step) }); e.preventDefault(); }
    else if (e.key === "ArrowUp") { onChange(selectedId, { y: round(layer.y - step) }); e.preventDefault(); }
    else if (e.key === "ArrowDown") { onChange(selectedId, { y: round(layer.y + step) }); e.preventDefault(); }
    else if (e.key === "Backspace" || e.key === "Delete") { onDelete(selectedId); e.preventDefault(); }
    else if (e.key === "d" && (e.metaKey || e.ctrlKey)) { onDuplicate(selectedId); e.preventDefault(); }
    else if (e.key === "Escape") onSelect(null);
  }

  const resolved = (str) => resolveBindings(str, context).value;

  return (
    <div
      ref={canvasRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={() => onSelect(null)}
      className="relative w-full select-none overflow-hidden rounded-xl outline-none"
      style={{
        aspectRatio: `${template.canvas.width} / ${template.canvas.height}`,
        background:
          `${template.background?.color || "#0b0b0c"} ` +
          "repeating-conic-gradient(#00000010 0% 25%, transparent 0% 50%) 50% / 24px 24px",
      }}
    >
      {/* base background fill (under checkerboard so transparency reads) */}
      <div className="absolute inset-0" style={{ background: template.background?.color || "#0b0b0c" }} />

      {template.layers.map((layer) => {
        if (layer.visible === false) return null;
        const selected = layer.id === selectedId;
        const wrap = {
          position: "absolute",
          left: `${layer.x}%`,
          top: `${layer.y}%`,
          width: `${layer.width}%`,
          height: `${layer.height}%`,
          transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
          opacity: layer.opacity ?? 1,
          cursor: layer.locked ? "default" : "move",
          outline: selected ? "2px solid #d946ef" : "1px dashed rgba(255,255,255,0.25)",
          outlineOffset: 0,
        };
        return (
          <div key={layer.id} style={wrap} onPointerDown={(e) => startDrag(e, layer)}>
            <LayerBody layer={layer} resolved={resolved} fpx={fpx} />
            {selected && !layer.locked &&
              HANDLES.map((h) => (
                <div
                  key={h}
                  onPointerDown={(e) => startResize(e, layer, h)}
                  style={handleStyle(h)}
                  className="absolute z-10 h-2.5 w-2.5 rounded-sm border border-fuchsia-500 bg-white"
                />
              ))}
          </div>
        );
      })}

      {/* snap guides */}
      {guides.v.map((v, i) => (
        <div key={"v" + i} className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-fuchsia-500" style={{ left: `${v}%` }} />
      ))}
      {guides.h.map((h, i) => (
        <div key={"h" + i} className="pointer-events-none absolute left-0 right-0 z-20 h-px bg-fuchsia-500" style={{ top: `${h}%` }} />
      ))}
    </div>
  );
}

function handleStyle(h) {
  const pos = { position: "absolute" };
  const at = (v) => `calc(${v} - 5px)`;
  if (h.includes("n")) pos.top = at("0%"); if (h.includes("s")) pos.top = at("100%");
  if (h.includes("w")) pos.left = at("0%"); if (h.includes("e")) pos.left = at("100%");
  if (h === "n" || h === "s") pos.left = at("50%");
  if (h === "e" || h === "w") pos.top = at("50%");
  pos.cursor = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" }[h];
  return pos;
}

const round = (n) => Math.round(n * 10) / 10;
