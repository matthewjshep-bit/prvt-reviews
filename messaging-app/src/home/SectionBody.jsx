// home/SectionBody.jsx — the ONE section layout. Every section renders exactly
// this anatomy so the page reads as a single system:
//
//   header   title + subtitle | card chip (opens Card & message) + stat pill
//   banner   setup CTA (no card assigned) or config error (missing tag)
//   body     list (left) | card preview (right)
//   footer   Edit message + Send to <name>; batch sections add the same
//            Preview audience + Send batch row beneath a divider
//
// The card template + outgoing message are DEFINED per section in the
// SectionSettings panel — explicit assignment, no name matching.

import React, { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { useSection, usePreview, useSend } from "./hooks.js";
import * as api from "./api.js";
import {
  SectionCard, HeadStat, RowList, PreviewPane, Skeleton, EmptyState, ErrorBanner, ConfigError,
  SendButton, SecondaryButton,
} from "./ui.jsx";
import { SingleSendFooter, BatchFooter } from "./footers.jsx";
import SectionSettings from "./SectionSettings.jsx";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [presetBusy, setPresetBusy] = useState(false);

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

  function onSettingsSaved() {
    reload();
    setPreviewVersion((v) => v + 1);
  }

  async function usePresetQuick() {
    setPresetBusy(true);
    try {
      await api.createFromPreset(section);
      onSettingsSaved();
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
              onClick={() => setSettingsOpen(true)}
              title="Card & message settings"
              className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Settings2 className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              <span className="truncate">{data.templateId ? data.templateName : "Set up card"}</span>
            </button>
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
                <span className="font-semibold">No card assigned.</span> Pick the template this section sends — takes one click with the preset.
              </div>
              <div className="flex gap-2">
                <div className="w-44">
                  <SecondaryButton onClick={() => setSettingsOpen(true)}>Choose template</SecondaryButton>
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

          {rows.length === 0 ? (
            <EmptyState>Nothing here right now — this queue is empty.</EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <RowList
                rows={rows}
                selectedId={selectedId}
                onSelect={(r) => setSelectedId(r.id)}
                renderRight={renderRowRight}
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
                      onEdit={() => setSettingsOpen(true)}
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

      <SectionSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        data={data}
        onSaved={onSettingsSaved}
      />
    </SectionCard>
  );
}
