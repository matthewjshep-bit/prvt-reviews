// home/QuoteFollowUp.jsx — contacts with an open quote (tag: quote-open),
// sorted by expiry then amount. Standard section layout; single-send.

import React from "react";
import SectionBody from "./SectionBody.jsx";
import { StatusPill } from "./ui.jsx";

export default function QuoteFollowUp({ active }) {
  return (
    <SectionBody
      section="quotes"
      id="quotes"
      active={active}
      title="Quote follow-up"
      subtitle="Open quotes, sorted by expiry"
      renderRowRight={(row) => <StatusPill status={row.status} />}
      previewNote="Sends as MMS through your quote follow-up workflow"
    />
  );
}
