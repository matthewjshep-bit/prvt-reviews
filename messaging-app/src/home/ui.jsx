// home/ui.jsx — shared presentational primitives for the Home sections. Kept
// deliberately dumb (props in, JSX out) so each section component stays thin and
// the whole page reads as one system. Light theme, existing Tailwind tokens.

import React from "react";
import { ChevronRight, Star } from "lucide-react";

export const BLUE = "#4c6ef5";   // outgoing SMS bubble (matches MessagingPage)
export const SEND_BLUE = "#1d4ed8"; // primary send button (matches mockups)

// Section display names — one place, used by Contacts + drawers.
export const SECTION_LABELS = { quotes: "Quotes", reviews: "Reviews", winback: "Win-back", offers: "Offers" };

// Small switch (used by the contact drawer's queue toggles).
export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40"
      style={{ backgroundColor: checked ? SEND_BLUE : "#d1d5db" }}
    >
      <span
        className="inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? "translateX(22px)" : "translateX(2px)" }}
      />
    </button>
  );
}

/* ---------- containers ---------- */

export function Card({ children, className = "" }) {
  return <div className={`rounded-xl border border-gray-200 bg-white ${className}`}>{children}</div>;
}

// One section block: title + subtitle on the left, a stat/badge on the right.
export function SectionCard({ title, subtitle, right, children, id }) {
  return (
    <section id={id} className="scroll-mt-6">
      <Card className="p-5 sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p> : null}
          </div>
          {right ? <div className="shrink-0 pt-1">{right}</div> : null}
        </div>
        {children}
      </Card>
    </section>
  );
}

// The right-aligned header stat (e.g. "5 open · $61,400" / "12 in queue").
// One style everywhere — sections must not diverge visually.
export function HeadStat({ children }) {
  if (!children) return null;
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600">
      {children}
    </span>
  );
}

/* ---------- list ---------- */

export function RowList({ rows, selectedId, onSelect, renderRight, onOpenContact }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      {rows.map((r, i) => {
        const active = r.id === selectedId;
        return (
          <button
            key={r.id || i}
            type="button"
            onClick={() => onSelect(r)}
            className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
              i > 0 ? "border-t border-gray-100" : ""
            } ${active ? "bg-blue-50" : "hover:bg-gray-50"}`}
          >
            <div className="min-w-0 flex-1">
              <div className={`truncate text-sm font-semibold ${active ? "text-blue-700" : "text-gray-900"}`}>
                {onOpenContact ? (
                  <span
                    role="link"
                    tabIndex={0}
                    title="Open contact"
                    onClick={(e) => { e.stopPropagation(); onOpenContact(r); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onOpenContact(r); } }}
                    className="cursor-pointer hover:underline"
                  >
                    {r.name}
                  </span>
                ) : (
                  r.name
                )}
              </div>
              <div className={`truncate text-xs ${active ? "text-blue-600" : "text-gray-500"}`}>{r.subtitle}</div>
              {r.warnings?.length ? (
                <div className="mt-0.5 truncate text-[11px] font-medium text-amber-600">⚠ {r.warnings.join(" · ")}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {renderRight ? renderRight(r) : null}
              <ChevronRight className={`h-4 w-4 ${active ? "text-blue-400" : "text-gray-300"}`} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

const PILL = {
  due: "bg-amber-50 text-amber-700",
  "no-reply": "bg-amber-50 text-amber-700",
  replied: "bg-green-50 text-green-700",
  left: "bg-green-50 text-green-700",
  scheduled: "bg-blue-50 text-blue-700",
  aged: "bg-amber-50 text-amber-700",
  agedFar: "bg-rose-50 text-rose-600",
  proven: "bg-indigo-50 text-indigo-700",
  repeat: "bg-blue-50 text-blue-700",
  new: "bg-gray-100 text-gray-600",
  neutral: "bg-gray-100 text-gray-600",
};

export function Pill({ variant = "neutral", children }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${PILL[variant] || PILL.neutral}`}>
      {children}
    </span>
  );
}

export function StatusPill({ status }) {
  if (!status) return null;
  if (status.kind === "left") {
    return (
      <Pill variant="left">
        {status.label} <Star className="h-3 w-3 fill-current" />{status.rating}
      </Pill>
    );
  }
  return <Pill variant={status.kind}>{status.label}</Pill>;
}

/* ---------- preview pane ---------- */

// "contact.custom.quote_amount" → "Quote Amount"; "data.tier.rate" → "Tier Rate".
function bindingLabel(b) {
  const tail = String(b).replace(/^contact\.custom\./, "").replace(/^contact\./, "").replace(/^loc\./, "").replace(/^data\./, "").replace(/\./g, "_");
  return tail.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// The dark card preview + outgoing message bubble + a note line. `footer` is
// the send controls (varies per section: single vs batch).
export function PreviewPane({ preview, loading, error, placeholder, note, footer }) {
  const missing = preview?.missingBindings || [];
  return (
    <div className="flex flex-col">
      <div className="overflow-hidden rounded-2xl bg-[#26292f] p-2 shadow-sm">
        <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[#1b1d22]">
          {preview?.url ? (
            <img src={preview.url} alt="Card preview" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-gray-400">
              {loading ? "Rendering card…" : error ? `Couldn’t render: ${error}` : placeholder || "Select a contact to preview"}
            </div>
          )}
          {loading && preview?.url ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs font-medium text-white">
              Rendering…
            </div>
          ) : null}
        </div>

        {/* honesty strip: fields that resolved EMPTY for this contact render
            blank on the card — say so instead of letting it ship silently. */}
        {preview?.url && missing.length > 0 ? (
          <div className="mx-0.5 mt-1.5 rounded-lg bg-amber-500/15 px-2.5 py-1.5 text-[11px] leading-snug text-amber-300">
            <span className="font-semibold">Blank on this card</span> (no value for this contact):{" "}
            {[...new Set(missing.map(bindingLabel))].join(", ")}
          </div>
        ) : null}

        {preview?.message ? (
          <div className="px-1.5 pb-1 pt-2.5">
            <div className="ml-auto max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-snug text-white" style={{ backgroundColor: BLUE }}>
              {preview.message}
            </div>
            {note ? <div className="mt-1.5 px-1 text-[11px] text-gray-400">{note}</div> : null}
          </div>
        ) : null}
      </div>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </div>
  );
}

/* ---------- buttons ---------- */

export function SendButton({ children, onClick, disabled, busy }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className="w-full rounded-lg py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
      style={{ backgroundColor: SEND_BLUE }}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

export function SecondaryButton({ children, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/* ---------- states ---------- */

export function Skeleton({ rows = 4 }) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="overflow-hidden rounded-xl border border-gray-200">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={`px-4 py-3.5 ${i > 0 ? "border-t border-gray-100" : ""}`}>
            <div className="h-3.5 w-32 animate-pulse rounded bg-gray-200" />
            <div className="mt-2 h-3 w-44 animate-pulse rounded bg-gray-100" />
          </div>
        ))}
      </div>
      <div className="aspect-square animate-pulse rounded-2xl bg-gray-100" />
    </div>
  );
}

export function EmptyState({ children }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-200 px-6 py-10 text-center text-sm text-gray-400">
      {children}
    </div>
  );
}

export function ErrorBanner({ children, onRetry }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <span>{children}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="shrink-0 font-semibold underline hover:text-red-900">
          Retry
        </button>
      ) : null}
    </div>
  );
}

// A configuration problem (missing tag/template) — actionable, not an error.
export function ConfigError({ children }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <span className="font-semibold">Setup needed:</span> {children}
    </div>
  );
}
