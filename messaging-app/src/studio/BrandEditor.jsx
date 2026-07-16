// BrandEditor.jsx — the Global Brand kit. Set background / accent / text
// colors and a font ONCE; every gallery template and every new card starts
// themed to the brand. Saved to the location's config custom values
// (rh_brand_*) through the existing /api/config endpoint.

import React, { useMemo, useState } from "react";
import { X } from "lucide-react";
import TemplatePreview from "./TemplatePreview.jsx";
import { applyBrand, BRAND_FONTS, INDUSTRY_LABELS } from "./brand.js";
import { quoteFollowUpStarter, offerTermsStarter } from "@shared/starters.js";

function ColorField({ label, value, onChange, placeholder }) {
  const valid = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test((value || "").trim());
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-gray-700">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={valid ? value.trim() : "#888888"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 cursor-pointer rounded border border-gray-200 bg-white p-0.5"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-blue-500"
        />
        {value ? (
          <button type="button" onClick={() => onChange("")} className="text-xs text-gray-400 underline hover:text-gray-600">
            clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function BrandEditor({ open, onClose, brand, onSave, saving }) {
  const [bg, setBg] = useState(brand?.background || "");
  const [accent, setAccent] = useState(brand?.accent || "");
  const [text, setText] = useState(brand?.text || "");
  const [font, setFont] = useState(brand?.font || "");
  const [industry, setIndustry] = useState(brand?.industry || "");

  // Re-seed when reopened with fresh saved values.
  React.useEffect(() => {
    if (!open) return;
    setBg(brand?.background || "");
    setAccent(brand?.accent || "");
    setText(brand?.text || "");
    setFont(brand?.font || "");
    setIndustry(brand?.industry || "");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = { background: bg, accent, text, font };
  const previews = useMemo(() => {
    const docs = [offerTermsStarter({ locationId: "brand" }), quoteFollowUpStarter({ locationId: "brand" })];
    return docs.map((d) => applyBrand(d, draft));
  }, [bg, accent, text, font]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Brand kit</h3>
            <p className="text-sm text-gray-500">
              Themes every gallery template and each new card you start. Your saved cards aren't touched.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-[1fr_1.1fr]">
          {/* controls */}
          <div className="space-y-4">
            <ColorField label="Background" value={bg} onChange={setBg} placeholder="#0f172a" />
            <ColorField label="Accent" value={accent} onChange={setAccent} placeholder="#d4af37" />
            <ColorField label="Text" value={text} onChange={setText} placeholder="#ffffff" />
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-700">Font</label>
              <select
                value={font}
                onChange={(e) => setFont(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm"
              >
                <option value="">Keep each template's font</option>
                {BRAND_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-700">Your industry</label>
              <select
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm"
              >
                <option value="">Show every industry</option>
                {Object.entries(INDUSTRY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-gray-400">The gallery opens showing your industry's templates (plus general ones).</p>
            </div>
            <p className="text-[11px] leading-relaxed text-gray-400">
              How it maps: dark colors in a template become your background, golds and other
              saturated colors become your accent, whites become your text color. Leave a
              swatch empty to keep the templates' original tone.
            </p>
          </div>

          {/* live preview on two representative templates */}
          <div>
            <div className="mb-1.5 text-xs font-semibold text-gray-500">Live preview</div>
            <div className="grid grid-cols-2 gap-2">
              {previews.map((d, i) => (
                <div key={i} className="overflow-hidden rounded-lg border border-gray-200">
                  <TemplatePreview template={d} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave({ background: bg.trim(), accent: accent.trim(), text: text.trim(), font, industry })}
            className="rounded-lg py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: "#1d4ed8" }}
          >
            {saving ? "Saving…" : "Save brand"}
          </button>
        </div>
      </div>
    </div>
  );
}
