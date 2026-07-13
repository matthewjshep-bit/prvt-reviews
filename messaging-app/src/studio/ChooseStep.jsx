// ChooseStep.jsx — step 1 of the Card Studio flow: pick what you're working
// on. Cards are organized by what they SEND FOR (the four Home sections),
// unassigned cards live in Drafts, and each section offers its matching
// preset as a one-click starting point. No toolbars, no dropdowns.

import React from "react";
import { starterList } from "@shared/starters.js";
import TemplatePreview from "./TemplatePreview.jsx";

const SECTION_META = [
  { key: "quotes", label: "Quote follow-up", starterId: "quote-follow-up", blurb: "Parcel aerial + quote amount" },
  { key: "reviews", label: "Reviews", starterId: "review-request", blurb: "Review ask with your branding" },
  { key: "winback", label: "Win-back", starterId: "property-card", blurb: "Property aerial for past customers" },
  { key: "offers", label: "Offers", starterId: "offer-terms", blurb: "Dark terms card with earned pricing" },
];
const MORE_CATEGORIES = ["Real estate", "Services", "General", "Reviews"];

function Tile({ children, onClick, title, subtitle, accent }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group w-44 shrink-0 overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-md ${
        accent ? "border-dashed border-gray-300 bg-gray-50 hover:border-blue-300" : "border-gray-200 bg-white"
      }`}
    >
      <div className="aspect-square w-full overflow-hidden bg-[#0b0b0c]">{children}</div>
      <div className="px-3 py-2">
        <div className="truncate text-sm font-semibold text-gray-900">{title}</div>
        {subtitle ? <div className="truncate text-[11px] text-gray-400">{subtitle}</div> : null}
      </div>
    </button>
  );
}

export default function ChooseStep({ templates, assignments, onEdit, onNewFromPreset, onNewFromStarter }) {
  const byId = new Map((templates || []).map((t) => [t.id, t]));
  const assignedIds = new Set(Object.values(assignments || {}));
  const drafts = (templates || []).filter((t) => !assignedIds.has(t.id));
  const starters = starterList();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Your cards</h2>
        <p className="mt-0.5 text-sm text-gray-500">
          Each section sends one card. Edit the one it uses, or start fresh from its preset.
        </p>
      </div>

      {SECTION_META.map(({ key, label, starterId, blurb }) => {
        const assigned = byId.get(assignments?.[key]);
        const starter = starters.find((s) => s.id === starterId);
        return (
          <section key={key}>
            <div className="mb-2 flex items-baseline gap-2">
              <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">{label}</h3>
              {assigned ? <span className="text-[11px] text-green-600">sends “{assigned.name}”</span> : <span className="text-[11px] text-amber-500">no card assigned yet</span>}
            </div>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {assigned ? (
                <Tile title={assigned.name} subtitle="Currently sending · Edit" onClick={() => onEdit(assigned.id)}>
                  <TemplatePreview template={assigned} />
                </Tile>
              ) : null}
              {starter ? (
                <Tile accent title={`＋ New from preset`} subtitle={blurb} onClick={() => onNewFromPreset(key, starter)}>
                  <div className="flex h-full w-full items-center justify-center bg-gray-100 text-3xl text-gray-300 transition-colors group-hover:text-blue-400">＋</div>
                </Tile>
              ) : null}
            </div>
          </section>
        );
      })}

      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">Drafts</h3>
          <span className="text-[11px] text-gray-400">saved cards not assigned to a section</span>
        </div>
        {drafts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-400">
            No drafts — every saved card is assigned.
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {drafts.map((t) => (
              <Tile key={t.id} title={t.name} subtitle={`v${t.version} · Edit`} onClick={() => onEdit(t.id)}>
                <TemplatePreview template={t} />
              </Tile>
            ))}
          </div>
        )}
      </section>

      <details className="rounded-xl border border-gray-200 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-gray-600">More presets (real estate, services, general…)</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {starters
            .filter((s) => MORE_CATEGORIES.includes(s.category) && !SECTION_META.some((m) => m.starterId === s.id))
            .map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onNewFromStarter(s)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                ＋ {s.name}
              </button>
            ))}
        </div>
      </details>
    </div>
  );
}
