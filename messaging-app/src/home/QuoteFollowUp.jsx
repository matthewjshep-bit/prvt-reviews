// home/QuoteFollowUp.jsx — contacts with an open quote (tag: quote-open),
// sorted by expiry then amount. Single-send: apply the trigger tag → workflow.

import React from "react";
import SectionBody from "./SectionBody.jsx";
import { HeadStat, StatusPill } from "./ui.jsx";
import { SingleSendFooter } from "./footers.jsx";

export default function QuoteFollowUp({ active, onEdit }) {
  return (
    <SectionBody
      section="quotes"
      id="quotes"
      active={active}
      title="Quote follow-up"
      subtitle="Open quotes, sorted by expiry"
      headerRight={(data) => <HeadStat>{data.summary?.headline}</HeadStat>}
      renderRowRight={(row) => <StatusPill status={row.status} />}
      previewNote="Sends as MMS through your quote follow-up workflow"
      footer={({ selected, preview, send, data }) => (
        <SingleSendFooter
          section="quotes"
          selected={selected}
          preview={preview}
          send={send}
          sendsEnabled={data?.sendsEnabled}
          onEdit={onEdit}
          label={(name) => `Send to ${name}`}
        />
      )}
    />
  );
}
