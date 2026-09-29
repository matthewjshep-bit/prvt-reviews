import React, { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { searchContacts } from "./api.js";

/**
 * Typeahead over existing GHL contacts: 300ms debounce, two characters
 * before it asks. `isTaken(c)` greys a result out with `takenLabel`.
 * Lifted out of the Deals modal's investor picker so the parties panel can
 * use the same one.
 */
export default function ContactSearch({ onPick, busy = false, placeholder = "Search your GHL contacts…", isTaken = null, takenLabel = "linked", autoFocus = false }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      setSearching(true);
      searchContacts(query.trim())
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query]);

  return (
    <div className="relative">
      <input
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        disabled={busy}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-60"
      />
      {searching && <Loader2 size={14} className="absolute right-3 top-3 animate-spin text-slate-400" />}
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {results.map((c) => {
            const taken = Boolean(isTaken?.(c));
            return (
              <button key={c.id} type="button" disabled={taken}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(c); setQuery(""); setResults([]); setOpen(false); }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50">
                <span>
                  <span className="font-medium">{c.name || "(no name)"}</span>
                  <span className="ml-2 text-xs text-slate-500">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                </span>
                {taken && <span className="text-[11px] text-slate-400">{takenLabel}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
