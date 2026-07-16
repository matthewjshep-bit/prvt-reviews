// home/SectionBody.jsx — the ONE section layout. Home DISPLAYS and SENDS;
// editing (card design, assignment, message) lives in the Card Studio — the
// header chip and "Edit card" deep-link straight there. Every section renders:
//
//   header   title + subtitle | card chip (→ studio) · ＋ Add contact · stat
//   banner   setup CTA (no card assigned) or config error (missing tag)
//   body     list (left) | card preview (right)
//   footer   Edit card + Send to <name>; batch sections add the same
//            Preview audience + Send batch row beneath a divider

import React, { useEffect, useRef, useState } from "react";
import { Settings2, UserPlus } from "lucide-react";
import { useSection, usePreview, useSend } from "./hooks.js";
import * as api from "./api.js";
import { gotoStudio } from "./api.js";
import {
  SectionCard, HeadStat, RowList, PreviewPane, Skeleton, EmptyState, ErrorBanner, ConfigError,
  SendButton, SecondaryButton, SECTION_LABELS,
} from "./ui.jsx";
import { SingleSendFooter, BatchFooter } from "./footers.jsx";
import ContactDrawer from "./ContactDrawer.jsx";

// ＋ Add contact — search-and-pick popover; picking applies the section's
// queue tag (server-side PATCH) so the contact joins this outreach.
function AddContactButton({ section, onAdded }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const d = await api.listContacts({ query: query.trim() });
        setResults((d.contacts || []).slice(0, 8));
      } catch { setResults([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  async function pick(c) {
    setBusy(true);
    try {
      await api.patchContact(c.id, { queues: { [section]: true } });
      setOpen(false);
      setQuery("");
      setResults([]);
      onAdded(c);
    } catch (e) {
      window.alert(`Couldn’t add — ${e.message || "error"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Add a contact to ${SECTION_LABELS[section] || section}`}
        className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        <UserPlus className="h-3.5 w-3.5 text-gray-400" />
        Add
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search contacts…"
            className="w-full rounded-lg border border-gray-300 px-2.5 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          <div className="mt-1 max-h-52 overflow-auto">
            {results.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy}
                onClick={() => pick(c)}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                <span className="truncate font-medium text-gray-800">{c.name}</span>
                <span className="ml-2 shrink-0 text-[10px] text-gray-400">{c.phone}</span>
              </button>
            ))}
            {query.trim() && !results.length ? (
              <div className="px-2.5 py-2 text-xs text-gray-400">No matches</div>
            ) : null}
          </div>
          <p className="mt-1 border-t border-gray-100 px-1 pt-1.5 text-[10px] text-gray-400">
            Adds the {SECTION_LABELS[section] || section} queue tag to the contact.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default function SectionBody({
  section,
  active,
  id,
  title,
  subtitle,
  renderRowRight, // (row) => node — the row's right-side pill
  previewNote,    // string | (selectedRow) => string
  batchMetric,    // (summary) => node — extra stat in the batch row (optional)
}) {
  const { data, loading, error, reload } = useSection(section, active);
  const send = useSend(section);
  const [selectedId, setSelectedId] = useState(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [presetBusy, setPresetBusy] = useState(false);
  const [drawerContactId, setDrawerContactId] = useState(null);
  const [notice, setNotice] = useState(null);

  const rows = data?.rows || [];
  // Auto-select the first row once the queue loads.
  useEffect(() => {
    if (rows.length && !rows.some((r) => r.id === selectedId)) setSelectedId(rows[0].id);
    if (!rows.length) setSelectedId(null);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = rows.find((r) => r.id === selectedId) || null;
  const preview = usePreview(section, selectedId, previewVersion);
  const note = typeof previewNote === "function" ? previewNote(selected) : previewNote;

  const unassigned = Boolean(data) && !data.templateId;

  function refresh() {
    reload();
    setPreviewVersion((v) => v + 1);
  }

  async function usePresetQuick() {
    setPresetBusy(true);
    try {
      await api.createFromPreset(section);
      refresh();
    } catch (e) {
      window.alert(`Couldn’t set up the preset — ${e.message}`);
    } finally {
      setPresetBusy(false);
    }
  }

  return (
    <SectionCard
      id={id}
      title={data?.label || title}
      subtitle={data?.subtitle || subtitle}
      right={
        data ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => gotoStudio(data.templateId || undefined)}
              title={data.templateId ? "Open this card in the Card Studio" : "Open the Card Studio"}
              className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Settings2 className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              <span className="truncate">{data.templateId ? data.templateName : "Set up card"}</span>
            </button>
            <AddContactButton
              section={section}
              onAdded={(c) => { setNotice(`${c.name} added to ${SECTION_LABELS[section] || section}.`); refresh(); }}
            />
            <HeadStat>{data.summary?.headline}</HeadStat>
          </div>
        ) : null
      }
    >
      {loading && !data ? (
        <Skeleton />
      ) : error ? (
        <ErrorBanner onRetry={reload}>{error}</ErrorBanner>
      ) : (
        <>
          {unassigned ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50/60 p-4">
              <div className="text-sm text-gray-700">
                <span className="font-semibold">No card assigned.</span> One click sets up this section's preset — or design your own in the studio.
              </div>
              <div className="flex gap-2">
                <div className="w-44">
                  <SecondaryButton onClick={() => gotoStudio()}>Open Card Studio</SecondaryButton>
                </div>
                <div className="w-44">
                  <SendButton onClick={usePresetQuick} busy={presetBusy}>Use the preset</SendButton>
                </div>
              </div>
            </div>
          ) : data?.configError ? (
            <div className="mb-4">
              <ConfigError>{data.configError}.</ConfigError>
            </div>
          ) : null}

          {notice ? (
            <div className="mb-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-800">{notice}</div>
          ) : null}

          {rows.length === 0 ? (
            <EmptyState>Nothing here right now — use “Add” above to put a contact in this queue.</EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <RowList
                rows={rows}
                selectedId={selectedId}
                onSelect={(r) => setSelectedId(r.id)}
                renderRight={renderRowRight}
                onOpenContact={(r) => { setSelectedId(r.id); setDrawerContactId(r.id); }}
              />
              <PreviewPane
                preview={preview.preview}
                loading={preview.loading}
                error={preview.error}
                note={note}
                placeholder={
                  unassigned
                    ? "Assign a card template to preview"
                    : selected
                    ? "Rendering card…"
                    : "Select a contact to preview their card"
                }
                footer={
                  <>
                    <SingleSendFooter
                      selected={selected}
                      preview={preview.preview}
                      send={send}
                      sendsEnabled={data?.sendsEnabled}
                      onEdit={() => gotoStudio(data?.templateId || undefined)}
                    />
                    {data?.batch ? <BatchFooter data={data} send={send} metric={batchMetric} /> : null}
                  </>
                }
              />
            </div>
          )}

          {send.result ? (
            <div className={`mt-4 rounded-lg p-3 text-xs ${send.result.failed ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-800"}`}>
              {typeof send.result.sent === "number"
                ? `Sent ${send.result.sent}.${send.result.failed ? ` ${send.result.failed} failed.` : ""}${send.result.skippedDnd ? ` ${send.result.skippedDnd} skipped (DND).` : ""}${send.result.skippedRecent ? ` ${send.result.skippedRecent} recently sent.` : ""}`
                : send.result.skipped === "dnd"
                ? "Skipped — this contact is opted out (DND)."
                : send.result.skipped === "recent"
                ? "Skipped — already sent within the last 24h."
                : send.result.sent
                ? "Sent."
                : "Done."}
              {send.result.errors?.length ? (
                <ul className="mt-1 list-disc pl-4">
                  {send.result.errors.map((e, i) => (
                    <li key={i}><span className="font-medium">{e.who}:</span> {e.error}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {/* contact pop-out — opened by clicking a contact's name in the list. */}
      <ContactDrawer
        contactId={drawerContactId}
        onClose={() => setDrawerContactId(null)}
        onChanged={refresh}
      />
    </SectionCard>
  );
}
