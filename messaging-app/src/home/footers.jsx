// home/footers.jsx — the standardized send controls. EVERY section renders the
// same footer under the card preview: "Edit message" + "Send to <name>". A
// batch-capable section (data.batch) shows the SAME second row beneath a
// divider: "Preview audience" + "Send batch of N". No per-section strips.
// The broker enforces DND, 24h dedupe, and the cap on every path.

import React from "react";
import { SendButton, SecondaryButton } from "./ui.jsx";

function confirmSend(msg) {
  return window.confirm(`${msg}\n\nThis texts real people and can’t be undone.`);
}

export function SingleSendFooter({ selected, preview, send, sendsEnabled, onEdit }) {
  if (!selected) return null;
  const name = selected.firstName || selected.name;
  const canSend = Boolean(preview?.url) && !selected.dnd;

  async function onSend() {
    if (sendsEnabled === false) {
      // Server forces a dry run; run it so the owner sees the safe result.
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
          {sendsEnabled === false ? "Preview send" : `Send to ${name}`}
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

// The batch row — identical for every batch section. Dry-run first ("Preview
// audience"), then a confirm-gated "Send batch of N" to the whole queue.
export function BatchFooter({ data, send, metric }) {
  const summary = data?.summary || {};
  const sendsEnabled = data?.sendsEnabled;
  const count = summary.count || 0;
  const a = send.audience;

  async function onPreview() {
    await send.previewAudience(null); // null = whole queue
  }
  async function onSend() {
    const n = a?.willSend ?? count;
    if (!n) return;
    if (!confirmSend(`Send to ${n} customer${n === 1 ? "" : "s"}?`)) return;
    await send.sendBatch(null);
  }

  return (
    <div className="mt-3 border-t border-gray-200 pt-3">
      <div className="mb-2 text-xs text-gray-500">
        Whole queue: <span className="font-semibold text-gray-900">{count}</span>
        {metric ? <span> · {metric(summary)}</span> : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <SecondaryButton onClick={onPreview} disabled={send.busy}>Preview audience</SecondaryButton>
        <SendButton
          onClick={onSend}
          busy={send.busy}
          disabled={!a || sendsEnabled === false || (a.willSend ?? 0) === 0}
        >
          {`Send batch of ${a ? a.willSend : count}`}
        </SendButton>
      </div>
      {a ? (
        <div className="mt-2 text-xs text-gray-500">
          {a.willSend} will receive it
          {a.skippedDnd ? ` · ${a.skippedDnd} skipped (DND)` : ""}
          {a.skippedRecent ? ` · ${a.skippedRecent} sent recently` : ""}
          {a.willSend >= a.cap ? ` · capped at ${a.cap}/run` : ""}
          {a.tierSplit ? ` · ${Object.entries(a.tierSplit).map(([k, v]) => `${v} ${k}`).join(", ")}` : ""}.
        </div>
      ) : (
        <div className="mt-2 text-xs text-gray-400">Preview the audience to confirm exactly who receives it before sending.</div>
      )}
      {sendsEnabled === false ? (
        <p className="mt-1 text-[11px] text-amber-600">Live sending is off — preview is a safe dry run.</p>
      ) : null}
    </div>
  );
}
