// ChooseStep.jsx — step 1 of the Card Studio flow.
//
//   YOUR CARDS  — everything you've made, first. Assigned cards carry their
//                 section badge; unassigned ones are drafts. Plus start-blank.
//   GALLERY     — premade templates grouped by what they send for (Quotes /
//                 Reviews / Win-back / Offers / More), filterable by industry.

import React, { useMemo, useState } from "react";
import { starterList, blankStarter } from "@shared/starters.js";
import TemplatePreview from "./TemplatePreview.jsx";

const PURPOSES = [
  { key: "quotes", label: "Quote follow-up", section: true },
  { key: "reviews", label: "Reviews", section: true },
  { key: "winback", label: "Win-back", section: true },
  { key: "offers", label: "Offers", section: true },
  { key: "imagery", label: "Property imagery", hint: "live per-contact imagery — parcel outline, satellite, street view" },
  { key: "general", label: "More" },
];
const INDUSTRY_LABELS = {
  "home-services": "Home services",
  roofing: "Roofing",
  "real-estate": "Real estate",
  lending: "Lending",
  general: "General",
};

function Tile({ children, onClick, title, subtitle, badge, dashed }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative w-44 shrink-0 overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-md ${
        dashed ? "border-dashed border-gray-300 bg-gray-50 hover:border-blue-300" : "border-gray-200 bg-white"
      }`}
    >
      <div className="aspect-square w-full overflow-hidden bg-[#0b0b0c]">{children}</div>
      {badge ? (
        <span className="absolute left-2 top-2 rounded-full bg-gray-900/80 px-2 py-0.5 text-[10px] font-semibold text-white">
          {badge}
        </span>
      ) : null}
      <div className="px-3 py-2">
        <div className="truncate text-sm font-semibold text-gray-900">{title}</div>
        {subtitle ? <div className="truncate text-[11px] text-gray-400">{subtitle}</div> : null}
      </div>
    </button>
  );
}

const Row = ({ children }) => <div className="flex gap-3 overflow-x-auto pb-1">{children}</div>;

export default function ChooseStep({ templates, assignments, onEdit, onNewFromPreset, onNewFromStarter }) {
  const [industry, setIndustry] = useState("");
  const starters = useMemo(() => starterList(), []);
  const sectionByTemplateId = useMemo(() => {
    const m = new Map();
    for (const [section, id] of Object.entries(assignments || {})) m.set(id, section);
    return m;
  }, [assignments]);
  const sectionLabel = (key) => PURPOSES.find((p) => p.key === key)?.label || key;

  const industries = useMemo(
    () => [...new Set(starters.map((s) => s.industry).filter(Boolean))],
    [starters]
  );
  const filtered = industry ? starters.filter((s) => s.industry === industry || s.industry === "general") : starters;

  // Gallery previews: build each starter's doc once (pure data, cheap).
  const galleryDocs = useMemo(() => {
    const m = new Map();
    for (const s of starters) {
      try { m.set(s.id, s.build({ locationId: "preview" })); } catch { /* skip broken */ }
    }
    return m;
  }, [starters]);

  return (
    <div className="space-y-8">
      {/* YOUR CARDS — first thing you see */}
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-xl font-bold text-gray-900">Your cards</h2>
          <span className="text-sm text-gray-400">edit one, or start fresh below</span>
        </div>
        <Row>
          <Tile dashed title="＋ Blank card" subtitle="Start from scratch" onClick={() => onNewFromStarter({ build: blankStarter })}>
            <div className="flex h-full w-full items-center justify-center bg-gray-100 text-4xl text-gray-300 group-hover:text-blue-400">＋</div>
          </Tile>
          {(templates || []).map((t) => {
            const section = sectionByTemplateId.get(t.id);
            return (
              <Tile
                key={t.id}
                title={t.name}
                subtitle={section ? "Currently sending · Edit" : "Draft · Edit"}
                badge={section ? sectionLabel(section) : "Draft"}
                onClick={() => onEdit(t.id)}
              >
                <TemplatePreview template={t} />
              </Tile>
            );
          })}
        </Row>
      </section>

      {/* GALLERY */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Template gallery</h2>
            <p className="mt-0.5 text-sm text-gray-500">Premade designs — pick one and make it yours.</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setIndustry("")}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${!industry ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              All industries
            </button>
            {industries.filter((i) => i !== "general").map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIndustry(industry === i ? "" : i)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${industry === i ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
              >
                {INDUSTRY_LABELS[i] || i}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          {PURPOSES.map(({ key, label, section, hint }) => {
            const items = filtered.filter((s) => (s.purpose || "general") === key);
            if (!items.length) return null;
            const assigned = assignments?.[key];
            return (
              <div key={key}>
                <div className="mb-2 flex items-baseline gap-2">
                  <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">{label}</h3>
                  {section ? (
                    <span className="text-[11px] text-gray-400">
                      {assigned ? "picking one replaces the current card on save" : "picking one assigns it on save"}
                    </span>
                  ) : hint ? (
                    <span className="text-[11px] text-gray-400">{hint}</span>
                  ) : null}
                </div>
                <Row>
                  {items.map((s) => (
                    <Tile
                      key={s.id}
                      title={s.name}
                      subtitle={INDUSTRY_LABELS[s.industry] || "General"}
                      onClick={() => (section ? onNewFromPreset(key, s) : onNewFromStarter(s))}
                    >
                      {galleryDocs.get(s.id) ? (
                        <TemplatePreview template={galleryDocs.get(s.id)} />
                      ) : (
                        <div className="h-full w-full bg-gray-100" />
                      )}
                    </Tile>
                  ))}
                </Row>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
