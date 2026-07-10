import React, { useRef, useState, useEffect } from "react";
import { resolveBindings, flatToContext } from "@shared/bindings.js";

/*
  TemplatePreview — a clean, NON-interactive render of a template (no selection
  outlines, handles, or drag). Same layer rendering as the editor canvas, so the
  phone preview and the editor stay in sync. `LayerBody` is shared with
  ClientCanvas so there's one rendering path.
*/

export const CSS_FONT = {
  Inter: "'Inter',system-ui,-apple-system,sans-serif",
  "Source Serif": "'Source Serif 4',Georgia,serif",
  "Archivo Black": "'Archivo Black','Arial Black',system-ui,sans-serif",
};
export const ICON_CHAR = { star: "★", phone: "☎", pin: "📍", check: "✓", dollar: "$" };

export default function TemplatePreview({ template, className = "" }) {
  const ref = useRef(null);
  const [cw, setCw] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCw(el.clientWidth));
    ro.observe(el);
    setCw(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (!template?.canvas) return null;
  const scale = cw / template.canvas.width;
  const fpx = (px) => Math.max(1, (px || 0) * scale);
  const context = flatToContext(template.sampleData || {});
  const resolved = (str) => resolveBindings(str, context).value;

  return (
    <div
      ref={ref}
      className={`relative w-full overflow-hidden ${className}`}
      style={{
        aspectRatio: `${template.canvas.width} / ${template.canvas.height}`,
        background: template.background?.color || "#0b0b0c",
      }}
    >
      {template.layers.map((layer) => {
        if (layer.visible === false) return null;
        return (
          <div
            key={layer.id}
            style={{
              position: "absolute",
              left: `${layer.x}%`,
              top: `${layer.y}%`,
              width: `${layer.width}%`,
              height: `${layer.height}%`,
              transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
              opacity: layer.opacity ?? 1,
            }}
          >
            <LayerBody layer={layer} resolved={resolved} fpx={fpx} />
          </div>
        );
      })}
    </div>
  );
}

// Shared layer content renderer (imported by ClientCanvas too).
export function LayerBody({ layer, resolved, fpx }) {
  if (layer.type === "image") {
    return layer.src ? (
      <img src={layer.src} alt="" draggable={false} className="pointer-events-none h-full w-full"
        style={{ objectFit: layer.fit === "contain" ? "contain" : "cover", borderRadius: fpx(layer.cornerRadius || 0) }} />
    ) : (
      <Placeholder label="🖼 image — pick a file" />
    );
  }
  if (layer.type === "dynamic-image") {
    return layer.thumbnailUrl ? (
      <img src={layer.thumbnailUrl} alt="" draggable={false} className="pointer-events-none h-full w-full"
        style={{ objectFit: layer.fit === "contain" ? "contain" : "cover" }} />
    ) : (
      <Placeholder label={`🛰 ${layer.sourceId || "data source"}`} />
    );
  }
  if (layer.type === "shape") {
    if (layer.shape === "ellipse") return <div className="pointer-events-none h-full w-full" style={{ background: layer.fill, borderRadius: "50%" }} />;
    if (layer.shape === "line") return <div className="pointer-events-none absolute left-0 right-0 top-1/2" style={{ height: fpx(layer.strokeWidth || 4), background: layer.stroke || layer.fill, transform: "translateY(-50%)" }} />;
    return <div className="pointer-events-none h-full w-full" style={{ background: layer.fill, borderRadius: fpx(layer.cornerRadius || 0) }} />;
  }
  if (layer.type === "text") {
    const val = resolved(layer.content);
    return (
      <div className="pointer-events-none flex h-full w-full items-center"
        style={{ justifyContent: layer.align === "center" ? "center" : layer.align === "right" ? "flex-end" : "flex-start" }}>
        <div style={{
          fontFamily: CSS_FONT[layer.fontFamily] || CSS_FONT.Inter,
          fontWeight: layer.fontWeight === "bold" ? 700 : 400,
          fontSize: fpx(layer.fontSize), color: layer.color, textAlign: layer.align, lineHeight: layer.lineHeight,
          width: "100%", overflow: "hidden",
        }}>
          {val || <span style={{ opacity: 0.4 }}>{layer.content}</span>}
        </div>
      </div>
    );
  }
  if (layer.type === "name-box") {
    const val = resolved(layer.content) || layer.content;
    return (
      <div className="pointer-events-none flex h-full w-full items-center justify-center">
        <div style={{
          background: layer.bgColor, color: layer.textColor,
          fontFamily: CSS_FONT[layer.fontFamily] || CSS_FONT.Inter, fontWeight: 700, fontSize: fpx(layer.fontSize),
          padding: `${fpx((layer.paddingY || 0) + layer.fontSize * 0.2)}px ${fpx(layer.paddingX || 40)}px`,
          borderRadius: layer.cornerRadius >= 999 ? 9999 : fpx(layer.cornerRadius || 0), whiteSpace: "nowrap",
        }}>{val}</div>
      </div>
    );
  }
  if (layer.type === "badge") {
    const val = resolved(layer.text);
    return (
      <div className="pointer-events-none flex h-full w-full items-center justify-center">
        <div style={{
          background: layer.bgColor, color: layer.textColor, display: "inline-flex", alignItems: "center", gap: fpx(layer.fontSize * 0.3),
          fontFamily: CSS_FONT[layer.fontFamily] || CSS_FONT.Inter, fontWeight: 700, fontSize: fpx(layer.fontSize),
          padding: `${fpx(layer.fontSize * 0.35)}px ${fpx(layer.fontSize * 0.6)}px`,
          borderRadius: (layer.cornerRadius ?? 999) >= 999 ? 9999 : fpx(layer.cornerRadius || 0), whiteSpace: "nowrap",
        }}>
          {layer.icon ? <span>{ICON_CHAR[layer.icon] || ""}</span> : null}
          {val ? <span>{val}</span> : null}
        </div>
      </div>
    );
  }
  return null;
}

export function Placeholder({ label }) {
  return (
    <div className="pointer-events-none flex h-full w-full items-center justify-center bg-white/5 text-center text-[11px] font-medium text-white/60">
      {label}
    </div>
  );
}
