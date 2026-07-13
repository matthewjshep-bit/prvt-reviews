// home/footers.jsx — the send controls shared across sections. Two shapes:
//   • SingleSendFooter — "Edit message" + "Send to <name>" (one contact).
//   • BatchStrip       — audience count + LTV/tier metrics + Preview + Send batch.
// Both route through the broker, which enforces DND, 24h dedupe, and the cap.

import React from "react";
import { SendButton, SecondaryButton } from "./ui.jsx";

function confirmSend(msg) {
  return window.confirm(`${msg}\n\nThis texts a real person and can’t be undone.`);
}

export function SingleSendFooter({ section, selected, preview, send, sendsEnabled, onEdit, label }) {
  if (!selected) return null;
  const name = selected.firstName || selected.name;
  const canSend = Boolean(preview?.url) && !selected.dnd;

  async function onSend() {
    if (sendsEnabled === false) {
      // Server will force a dry run; run it so the owner sees the safe result.
      await send.sendOne(selected.id, { dryRun: true });
      return;
    }
    if (!confirmSend(`Send this card to ${name}?`)) return;
    await send.sendOne(selected.id, { dryRun: false });
  }

  return (
    <div>
      {selected.dnd ? (
        <div className="mb-2 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-500">
          {name} is opted out (DND) — sending is disabled for this contact.
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <SecondaryButton onClick={() => onEdit?.()}>Edit message</SecondaryButton>
        <SendButton onClick={onSend} busy={send.busy} disabled={!canSend}>
          {sendsEnabled === false ? "Preview send" : label(name)}
        </SendButton>
      </div>
      {sendsEnabled === false ? (
        <p className="mt-2 text-[11px] text-amber-600">
          Live sending is off — set <code>CARD_SENDS_ENABLED=true</code> on the broker to send for real.
        </p>
      ) : null}
    </div>
  );
}

// Batch strip that sits above a section's list (Win-Back / Offers). Shows the
// audience summary, a dry-run "Preview audience", and a confirm-gated send.
export function BatchStrip({ section, data, send, label, metric }) {
  const summary = data?.summary || {};
  const sendsEnabled = data?.sendsEnabled;
  const count = summary.count || 0;
  const a = send.audience;

  async function onPreview() {
    await send.previewAudience(null); // null = whole queue
  }
  async function onSend() {
    const n = a?.willSend ?? count;
    if (!confirmSend(`Send to ${n} customer${n === 1 ? "" : "s"}?`)) return;
    await send.sendBatch(null);
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-700">
          <span className="text-gray-500">This batch: </span>
          <span className="font-semibold text-gray-900">{count} {count === 1 ? "customer" : "customers"}</span>
          {metric ? <span className="ml-1">{metric(summary)}</span> : null}
          {a?.skippedDnd ? <span className="ml-2 text-gray-400">{a.skippedDnd} skipped (DND)</span> : null}
          {a?.skippedRecent ? <span className="ml-2 text-gray-400">{a.skippedRecent} sent recently</span> : null}
        </div>
        <div className="flex gap-2">
          <div className="w-40"><SecondaryButton onClick={onPreview} disabled={send.busy}>Preview audience</SecondaryButton></div>
          <div className="w-44">
            <SendButton
              onClick={onSend}
              busy={send.busy}
              disabled={!a || sendsEnabled === false || (a.willSend ?? 0) === 0}
            >
              {label(a ? a.willSend : count)}
            </SendButton>
          </div>
        </div>
      </div>
      {a ? (
        <div className="mt-2 text-xs text-gray-500">
          {a.willSend} will receive it{a.willSend >= a.cap ? ` (capped at ${a.cap}/run)` : ""}.
          {a.sample?.length ? ` e.g. ${a.sample.map((s) => s.firstName).filter(Boolean).join(", ")}` : ""}
        </div>
      ) : (
        <div className="mt-2 text-xs text-gray-400">Hit “Preview audience” to confirm exactly who receives it before sending.</div>
      )}
      {sendsEnabled === false ? (
        <p className="mt-1 text-[11px] text-amber-600">Live sending is off — this preview is a safe dry run.</p>
      ) : null}
    </div>
  );
}
