// ChooseStep.jsx — step 1 of the Card Studio flow. Kept deliberately calm:
//
//   YOUR CARDS  — capped row (expand for the rest) + start-blank.
//   GALLERY     — the four section groups only, pre-filtered to the brand's
//                 industry (set in the Brand kit). Imagery bases + extras live
//                 in a collapsed "More templates" drawer.

import React, { useEffect, useMemo, useState } from "react";
import { starterList, blankStarter } from "@shared/starters.js";
import TemplatePreview from "./TemplatePreview.jsx";
import { applyBrand, hasBrand, INDUSTRY_LABELS } from "./brand.js";

const PURPOSES = [
  { key: "quotes", label: "Quote follow-up" },
  { key: "reviews", label: "Reviews" },
  { key: "winback", label: "Win-back" },
  { key: "offers", label: "Offers" },
];
const CARDS_VISIBLE = 7; // + blank tile = two full rows of 4

// size: "lg" fills its grid cell (Your cards); default is the compact gallery tile.
function Tile({ children, onClick, title, subtitle, badge, dashed, size }) {
  const lg = size === "lg";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-md ${
        lg ? "w-full" : "w-36 shrink-0"
      } ${dashed ? "border-dashed border-gray-300 bg-gray-50 hover:border-blue-300" : "border-gray-200 bg-white"}`}
    >
      <div className="aspect-square w-full overflow-hidden bg-[#0b0b0c]">{children}</div>
      {badge ? (
        <span className={`absolute rounded-full bg-gray-900/80 font-semibold text-white ${lg ? "left-2.5 top-2.5 px-2.5 py-1 text-[11px]" : "left-1.5 top-1.5 px-2 py-0.5 text-[10px]"}`}>
          {badge}
        </span>
      ) : null}
      <div className={lg ? "px-3.5 py-2.5" : "px-2.5 py-1.5"}>
        <div className={`truncate font-semibold text-gray-900 ${lg ? "text-[15px]" : "text-[13px]"}`}>{title}</div>
        {subtitle ? <div className={`truncate text-gray-400 ${lg ? "text-xs" : "text-[10px]"}`}>{subtitle}</div> : null}
      </div>
    </button>
  );
}

const Row = ({ children }) => <div className="flex gap-3 overflow-x-auto pb-1">{children}</div>;

export default function ChooseStep({ templates, assignments, brand, onOpenBrand, onEdit, onNewFromPreset, onNewFromStarter }) {
  // Gallery filter defaults to the brand's industry; chips override per visit.
  const [industry, setIndustry] = useState(brand?.industry || "");
  useEffect(() => { setIndustry(brand?.industry || ""); }, [brand?.industry]);
  const [showAllCards, setShowAllCards] = useState(false);

  const starters = useMemo(() => starterList(), []);
  const sectionByTemplateId = useMemo(() => {
    const m = new Map();
    for (const [section, id] of Object.entries(assignments || {})) m.set(id, section);
    return m;
  }, [assignments]);
  const sectionLabel = (key) => PURPOSES.find((p) => p.key === key)?.label || key;

  const industries = useMemo(
    () => [...new Set(starters.map((s) => s.industry).filter((i) => i && i !== "general"))],
    [starters]
  );
  const filtered = industry ? starters.filter((s) => s.industry === industry || s.industry === "general") : starters;

  // Gallery previews: build once per starter, themed to the brand kit.
  const galleryDocs = useMemo(() => {
    const m = new Map();
    for (const s of starters) {
      try { m.set(s.id, applyBrand(s.build({ locationId: "preview" }), brand || {})); } catch { /* skip broken */ }
    }
    return m;
  }, [starters, brand]);

  const cards = templates || [];
  const visibleCards = showAllCards ? cards : cards.slice(0, CARDS_VISIBLE);
  const hiddenCount = cards.length - visibleCards.length;

  const extras = filtered.filter((s) => !PURPOSES.some((p) => p.key === s.purpose));

  return (
    <div className="space-y-8">
      {/* YOUR CARDS */}
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-xl font-bold text-gray-900">Your cards</h2>
          <span className="text-sm text-gray-400">edit one, or start fresh below</span>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          <Tile size="lg" dashed title="＋ Blank card" subtitle="Start from scratch" onClick={() => onNewFromStarter({ build: blankStarter })}>
            <div className="flex h-full w-full items-center justify-center bg-gray-100 text-5xl text-gray-300 group-hover:text-blue-400">＋</div>
          </Tile>
          {visibleCards.map((t) => {
            const section = sectionByTemplateId.get(t.id);
            return (
              <Tile
                size="lg"
                key={t.id}
                title={t.name}
                subtitle={section ? "Currently sending" : "Draft"}
                badge={section ? sectionLabel(section) : null}
                onClick={() => onEdit(t.id)}
              >
                <TemplatePreview template={t} />
              </Tile>
            );
          })}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAllCards(true)}
              className="flex w-full items-center justify-center rounded-xl border border-gray-200 bg-white text-base font-semibold text-gray-500 hover:bg-gray-50"
              style={{ minHeight: "120px" }}
            >
              +{hiddenCount} more
            </button>
          ) : null}
        </div>
      </section>

      {/* GALLERY */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Template gallery</h2>
            <p className="mt-0.5 text-sm text-gray-500">
              {industry ? `${INDUSTRY_LABELS[industry] || industry} designs — pick one and make it yours.` : "Pick one and make it yours."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenBrand}
              title="Colors, font, and industry — themes the whole gallery and every new card"
              className="mr-1 inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {hasBrand(brand || {}) ? (
                <span className="flex items-center gap-0.5">
                  {[brand.background, brand.accent, brand.text].filter(Boolean).map((c, i) => (
                    <span key={i} className="h-3 w-3 rounded-full border border-gray-200" style={{ backgroundColor: c }} />
                  ))}
                </span>
              ) : (
                <span>🎨</span>
              )}
              Brand kit
            </button>
            <button
              type="button"
              onClick={() => setIndustry("")}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${!industry ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              All
            </button>
            {industries.map((i) => (
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
          {PURPOSES.map(({ key, label }) => {
            const items = filtered.filter((s) => s.purpose === key);
            if (!items.length) return null;
            return (
              <div key={key}>
                <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-500">{label}</h3>
                <Row>
                  {items.map((s) => (
                    <Tile
                      key={s.id}
                      title={s.name}
                      subtitle={INDUSTRY_LABELS[s.industry] || "General"}
                      onClick={() => onNewFromPreset(key, s)}
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

          {/* everything else stays out of the way */}
          {extras.length ? (
            <details className="rounded-xl border border-gray-200 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-gray-600">
                More templates — live property imagery bases &amp; extras ({extras.length})
              </summary>
              <div className="mt-3">
                <Row>
                  {extras.map((s) => (
                    <Tile
                      key={s.id}
                      title={s.name}
                      subtitle={s.purpose === "imagery" ? "Live per-contact imagery" : INDUSTRY_LABELS[s.industry] || "General"}
                      onClick={() => onNewFromStarter(s)}
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
            </details>
          ) : null}
        </div>
      </section>
    </div>
  );
}
