// home/Offers.jsx — existing customers segmented into earned tiers
// (tag: offer-eligible). A tier strip defines the tiers + terms; each row shows
// the track-record line and tier pill; the preview is the dark terms card with
// that contact's tier terms. "Send to all" renders a per-contact card per tier.

import React from "react";
import SectionBody from "./SectionBody.jsx";
import { HeadStat, Pill, SendButton } from "./ui.jsx";
import { SingleSendFooter } from "./footers.jsx";

// "4+ deals" / "2–3 deals" / "New" from the tier list (sorted desc by minDeals).
function tierRuleLabel(tiers, i) {
  const min = tiers[i]?.rule?.minDeals ?? 0;
  const prevMin = i > 0 ? tiers[i - 1]?.rule?.minDeals ?? min : null;
  if (min === 0) return "";
  if (prevMin == null) return `${min}+ deals`;
  return prevMin - 1 > min ? `${min}–${prevMin - 1} deals` : `${min}+ deals`;
}

function TierStrip({ data, send }) {
  const tiers = data?.tiers || [];
  const sendsEnabled = data?.sendsEnabled;
  const count = data?.summary?.count || 0;

  async function onSendAll() {
    // Dry-run first so the confirm shows the exact audience + tier split.
    const a = await send.previewAudience(null);
    const n = a?.willSend ?? count;
    if (!n) { window.alert("No eligible recipients right now."); return; }
    const split = a?.tierSplit ? " (" + Object.entries(a.tierSplit).map(([k, v]) => `${v} ${k}`).join(", ") + ")" : "";
    if (sendsEnabled === false) { window.alert(`Live sending is off — dry run only. Would send to ${n}${split}.`); return; }
    if (!window.confirm(`Send to all ${n} contacts${split}?\n\nEach gets their tier's card. This texts real people and can’t be undone.`)) return;
    await send.sendBatch(null);
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-gray-500">Tiers:</span>
          {tiers.map((t, i) => {
            const rule = tierRuleLabel(tiers, i);
            return (
              <span key={t.id} className="inline-flex items-center rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-700 ring-1 ring-gray-200">
                <span className="text-gray-900">{t.label}</span>
                {rule ? <span className="mx-1 text-gray-400">·</span> : null}
                {rule ? <span className="text-gray-500">{rule}</span> : null}
                <span className="mx-1 text-gray-400">·</span>
                <span className="font-semibold text-gray-900">{t.terms?.rate}</span>
              </span>
            );
          })}
        </div>
        <div className="w-40">
          <SendButton onClick={onSendAll} busy={send.busy} disabled={count === 0}>
            {`Send to all ${count}`}
          </SendButton>
        </div>
      </div>
      {send.audience ? (
        <div className="mt-2 text-xs text-gray-500">
          {send.audience.willSend} will receive it
          {send.audience.skippedDnd ? ` · ${send.audience.skippedDnd} skipped (DND)` : ""}
          {send.audience.skippedRecent ? ` · ${send.audience.skippedRecent} sent recently` : ""}
          {send.audience.willSend >= send.audience.cap ? ` · capped at ${send.audience.cap}/run` : ""}.
        </div>
      ) : null}
    </div>
  );
}

const TIER_VARIANT = { proven: "proven", repeat: "repeat", new: "new" };

export default function Offers({ active, onEdit }) {
  return (
    <SectionBody
      section="offers"
      id="offers"
      active={active}
      title="Offers"
      subtitle="Existing customers, segmented by track record"
      headerRight={(data) => <HeadStat tone="blue">{data.summary?.headline}</HeadStat>}
      topStrip={(data, send) => <TierStrip data={data} send={send} />}
      renderRowRight={(row) =>
        row.tier ? <Pill variant={TIER_VARIANT[row.tier.id] || "neutral"}>{row.tier.label}</Pill> : null
      }
      previewNote="Existing client · terms pulled from data.tier"
      footer={({ selected, preview, send, data }) => (
        <SingleSendFooter
          section="offers"
          selected={selected}
          preview={preview}
          send={send}
          sendsEnabled={data?.sendsEnabled}
          onEdit={onEdit}
          label={(name) => `Send only to ${name}`}
        />
      )}
    />
  );
}
