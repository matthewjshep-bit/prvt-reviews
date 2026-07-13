// home/SectionBody.jsx — the shared list → preview → send scaffold every section
// uses. Owns the section's data hook, row selection (auto-selects the first
// row), the preview render, and the send state machine. Section-specific bits
// (header stat, row-right badge, batch/tier strip, preview note, send footer)
// come in as render props.

import React, { useEffect, useState } from "react";
import { useSection, usePreview, useSend } from "./hooks.js";
import {
  SectionCard, RowList, PreviewPane, Skeleton, EmptyState, ErrorBanner, ConfigError,
} from "./ui.jsx";

export default function SectionBody({
  section,
  active,
  id,
  title,
  subtitle,
  headerRight,   // (data, send) => node
  topStrip,      // (data, send, ctx) => node   (batch/tier strip above the list)
  renderRowRight,// (row) => node
  previewNote,   // string | (selected) => string
  footer,        // ({ selected, preview, send, reload }) => node
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

  const ctx = { data, rows, selected, setSelectedId, reload };

  return (
    <SectionCard
      id={id}
      title={data?.label || title}
      subtitle={data?.subtitle || subtitle}
      right={data && headerRight ? headerRight(data, send) : null}
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

          {topStrip ? <div className="mb-4">{topStrip(data, send, ctx)}</div> : null}

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
                footer={footer ? footer({ selected, preview: preview.preview, send, reload, data }) : null}
              />
            </div>
          )}

          {send.result ? (
            <div className={`mt-4 rounded-lg p-3 text-xs ${send.result.failed ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-800"}`}>
              {send.result.sent != null && typeof send.result.sent === "number"
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
