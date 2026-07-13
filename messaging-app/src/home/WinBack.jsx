// home/WinBack.jsx — past customers whose last service is 12+ months old
// (tag: winback-due), sorted by lifetime value. Batch-send strip at the top
// (audience + total LTV + DND-skipped, dry-run preview, confirm) plus a
// per-contact "Send only to <name>" in the preview footer.

import React from "react";
import SectionBody from "./SectionBody.jsx";
import { HeadStat, Pill } from "./ui.jsx";
import { BatchStrip, SingleSendFooter } from "./footers.jsx";

export default function WinBack({ active, onEdit }) {
  return (
    <SectionBody
      section="winback"
      id="winback"
      active={active}
      title="Win-back"
      subtitle="Past customers going quiet — sorted by lifetime value"
      headerRight={(data) => <HeadStat tone="blue">{data.summary?.headline}</HeadStat>}
      topStrip={(data, send) => (
        <BatchStrip
          section="winback"
          data={data}
          send={send}
          label={(n) => `Send batch of ${n}`}
          metric={(s) => (s.totalLtvLabel ? <span className="font-semibold text-gray-900">{s.totalLtvLabel} lifetime value</span> : null)}
        />
      )}
      renderRowRight={(row) =>
        row.monthsAgo != null ? <Pill variant={row.monthsAgo >= 18 ? "agedFar" : "aged"}>{row.monthsLabel}</Pill> : null
      }
      previewNote="Reply STOP to opt out · sends 1/day per customer max"
      footer={({ selected, preview, send, data }) => (
        <SingleSendFooter
          section="winback"
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
