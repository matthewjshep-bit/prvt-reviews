// home/WinBack.jsx — past customers going quiet (tag: winback-due), sorted by
// lifetime value. Standard section layout; batch row appears because the
// backend flags this section batch:true.

import React from "react";
import SectionBody from "./SectionBody.jsx";
import { Pill } from "./ui.jsx";

export default function WinBack({ active, onEdit }) {
  return (
    <SectionBody
      section="winback"
      id="winback"
      active={active}
      onEdit={onEdit}
      title="Win-back"
      subtitle="Past customers going quiet — sorted by lifetime value"
      renderRowRight={(row) =>
        row.monthsAgo != null ? <Pill variant={row.monthsAgo >= 18 ? "agedFar" : "aged"}>{row.monthsLabel}</Pill> : null
      }
      previewNote="Reply STOP to opt out · sends 1/day per customer max"
      batchMetric={(s) => (s.totalLtvLabel ? <span className="font-semibold text-gray-900">{s.totalLtvLabel} lifetime value</span> : null)}
    />
  );
}
