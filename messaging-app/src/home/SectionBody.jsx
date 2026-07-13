// home/SectionBody.jsx — the ONE section layout. Every section renders exactly
// this anatomy so the page reads as a single system:
//
//   header   title + subtitle | uniform stat pill (summary.headline)
//   banner   setup / config error (when applicable)
//   body     list (left) | card preview (right)
//   footer   Edit message + Send to <name>; batch sections add the same
//            Preview audience + Send batch row beneath a divider
//
// Sections customize DATA only: the row badge (renderRowRight), the preview
// note line, and an optional batch metric. Layout and controls are fixed here.

import React, { useEffect, useState } from "react";
import { useSection, usePreview, useSend } from "./hooks.js";
import {
  SectionCard, HeadStat, RowList, PreviewPane, Skeleton, EmptyState, ErrorBanner, ConfigError,
} from "./ui.jsx";
import { SingleSendFooter, BatchFooter } from "./footers.jsx";

export default function SectionBody({
  section,
  active,
  id,
  title,
  subtitle,
  onEdit,
  renderRowRight, // (row) => node — the row's right-side pill
  previewNote,    // string | (selectedRow) => string
  batchMetric,    // (summary) => node — extra stat in the batch row (optional)
}) {
  const { data, loading, error, reload } = useSection(section, active);
  const send = useSend(section);
  const [selectedId, setSelectedId] = useState(null);

  const rows = data?.rows || [];
  // Auto-select the first row once the queue loads.
  useEffect(() => {
    if (rows.length && !rows.some((r) => r.id === selectedId)) setSelectedId(rows[0].id);
    if (!rows.length) setSelectedId(null);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = rows.find((r) => r.id === selectedId) || null;
  const preview = usePreview(section, selectedId);
  const note = typeof previewNote === "function" ? previewNote(selected) : previewNote;

  return (
    <SectionCard
      id={id}
      title={data?.label || title}
      subtitle={data?.subtitle || subtitle}
      right={<HeadStat>{data?.summary?.headline}</HeadStat>}
    >
      {loading && !data ? (
        <Skeleton />
      ) : error ? (
        <ErrorBanner onRetry={reload}>{error}</ErrorBanner>
      ) : (
        <>
          {data?.configError ? (
            <div className="mb-4">
              <ConfigError>{data.configError}. Previews and sends are disabled until it exists.</ConfigError>
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
                placeholder={selected ? "Rendering card…" : "Select a contact to preview their card"}
                footer={
                  <>
                    <SingleSendFooter
                      selected={selected}
                      preview={preview.preview}
                      send={send}
                      sendsEnabled={data?.sendsEnabled}
                      onEdit={onEdit}
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
    </SectionCard>
  );
}
