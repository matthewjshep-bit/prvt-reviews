// home/Contacts.jsx — the app-specific contact list: every contact in the
// location, searchable, with filter chips for our queues + DND, cursor-paged.
// Clicking a row opens the ContactDrawer (view + manage). Modeled on the
// reference contacts screen but built around OUR data.

import React, { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import * as api from "./api.js";
import { Card, Pill, EmptyState, ErrorBanner, SecondaryButton, SECTION_LABELS } from "./ui.jsx";
import ContactDrawer from "./ContactDrawer.jsx";

const QUEUE_PILL = { quotes: "scheduled", reviews: "due", winback: "aged", offers: "proven" };
const FILTERS = [
  { key: "", label: "All" },
  ...Object.entries(SECTION_LABELS).map(([key, label]) => ({ key, label })),
  { key: "dnd", label: "DND" },
];

const fmtDate = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
};

export default function Contacts() {
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [drawerId, setDrawerId] = useState(null);
  const seq = useRef(0);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setQuery(queryInput.trim()), 350);
    return () => clearTimeout(t);
  }, [queryInput]);

  // (Re)load on query/filter change; `more` appends via the cursor.
  async function load(more = false) {
    const mySeq = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const params = { query, filter };
      if (more && cursor) { params.startAfter = cursor.startAfter; params.startAfterId = cursor.startAfterId; }
      const d = await api.listContacts(params);
      if (mySeq !== seq.current) return; // stale response
      setRows((prev) => (more ? [...prev, ...(d.contacts || [])] : d.contacts || []));
      setCursor(d.cursor || null);
    } catch (e) {
      if (mySeq === seq.current) setError(e.message || "Couldn’t load contacts");
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
  }
  useEffect(() => { load(false); }, [query, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawer edits (queues/DND) reflect back into the visible row.
  function onContactChanged(updated) {
    if (!updated?.id) return;
    setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Contacts</h2>
          <p className="mt-0.5 text-sm text-gray-500">Everyone in this location — queues, fields, and send history</p>
        </div>
        <span className="whitespace-nowrap pt-1 text-sm text-gray-500">
          {rows.length} contact{rows.length === 1 ? "" : "s"}{cursor ? "+" : ""}
        </span>
      </div>

      {/* search + filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="Search by name, email, or phone…"
            className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === f.key ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <ErrorBanner onRetry={() => load(false)}>{error}</ErrorBanner>
      ) : loading && rows.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-gray-200">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={`px-4 py-3.5 ${i > 0 ? "border-t border-gray-100" : ""}`}>
              <div className="h-3.5 w-40 animate-pulse rounded bg-gray-200" />
              <div className="mt-2 h-3 w-56 animate-pulse rounded bg-gray-100" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState>{query ? "No contacts match your search." : "No contacts here yet."}</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200">
          {/* header */}
          <div className="hidden grid-cols-[2fr_1.3fr_2fr_1.6fr_0.9fr] gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 sm:grid">
            <div>Name</div><div>Phone</div><div>Email</div><div>Queues</div><div>Added</div>
          </div>
          {rows.map((r, i) => (
            <button
              key={r.id || i}
              type="button"
              onClick={() => setDrawerId(r.id)}
              className={`grid w-full grid-cols-1 gap-1 px-4 py-3 text-left transition-colors hover:bg-gray-50 sm:grid-cols-[2fr_1.3fr_2fr_1.6fr_0.9fr] sm:items-center sm:gap-3 ${
                i > 0 ? "border-t border-gray-100" : ""
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <span className="truncate">{r.name}</span>
                {r.dnd ? <Pill variant="agedFar">DND</Pill> : null}
              </div>
              <div className="truncate text-sm text-gray-600">{r.phone || "—"}</div>
              <div className="truncate text-sm text-gray-600">{r.email || "—"}</div>
              <div className="flex flex-wrap gap-1">
                {(r.queues || []).length
                  ? r.queues.map((q) => <Pill key={q} variant={QUEUE_PILL[q] || "neutral"}>{SECTION_LABELS[q]}</Pill>)
                  : <span className="text-xs text-gray-300">—</span>}
              </div>
              <div className="text-sm text-gray-500">{fmtDate(r.addedAt)}</div>
            </button>
          ))}
        </div>
      )}

      {cursor && !error ? (
        <div className="mt-4 flex justify-center">
          <div className="w-40">
            <SecondaryButton onClick={() => load(true)} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </SecondaryButton>
          </div>
        </div>
      ) : null}

      <ContactDrawer
        contactId={drawerId}
        onClose={() => setDrawerId(null)}
        onChanged={onContactChanged}
      />
    </Card>
  );
}
