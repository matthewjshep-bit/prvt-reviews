// NotesPanel.jsx — the contact's GHL notes as a clean right-hand rail on the
// New Offer page: every note, newest first, plus a composer that writes back
// to the contact record. Presentation-only; the parent owns the data.

import React, { useState } from "react";
import { Loader2, Send, StickyNote } from "lucide-react";

const dateLabel = (d) => {
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
};

export default function NotesPanel({ contactName, notes, loading, error, onAdd }) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  async function submit() {
    const body = draft.trim();
    if (!body || adding) return;
    setAdding(true);
    setAddError("");
    try {
      await onAdd(body);
      setDraft("");
    } catch (e) { setAddError(e.message); }
    setAdding(false);
  }

  return (
    <div className="sticky top-16 flex max-h-[calc(100vh-5rem)] flex-col rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
        <StickyNote size={14} className="text-gray-400" />
        <h2 className="text-sm font-bold">Notes</h2>
        <span className="truncate text-xs text-gray-400">{contactName || ""}</span>
        {!loading && notes.length > 0 && (
          <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">
            {notes.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 size={16} className="animate-spin text-gray-300" />
          </div>
        ) : error ? (
          <p className="py-4 text-xs text-red-600">Couldn't load notes: {error}</p>
        ) : notes.length === 0 ? (
          <p className="py-4 text-xs text-gray-400">No notes on this contact yet.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {notes.map((n, i) => (
              <div key={n.id || i} className="py-2.5">
                {n.dateAdded && (
                  <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                    {dateLabel(n.dateAdded)}
                  </div>
                )}
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-700">{n.body}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-gray-100 p-3">
        {addError && <p className="mb-1.5 text-xs text-red-600">{addError}</p>}
        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
            placeholder="Add a note…"
            className="min-h-[38px] w-full resize-none rounded-lg border border-gray-300 px-2.5 py-2 text-xs focus:border-gray-900 focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || adding}
            className="shrink-0 rounded-lg bg-gray-900 p-2 text-white hover:bg-gray-800 disabled:opacity-30"
            title="Save note to the contact (⌘↵)"
          >
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
