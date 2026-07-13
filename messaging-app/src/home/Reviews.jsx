// home/Reviews.jsx — recently completed jobs awaiting a review ask
// (tag: review-due), freshest first. Single-send → review-request workflow.

import React from "react";
import SectionBody from "./SectionBody.jsx";
import { HeadStat, StatusPill } from "./ui.jsx";
import { SingleSendFooter } from "./footers.jsx";

export default function Reviews({ active, onEdit }) {
  return (
    <SectionBody
      section="reviews"
      id="reviews"
      active={active}
      title="Reviews"
      subtitle="Ask while the job is still fresh"
      headerRight={(data) => <HeadStat tone="amber">{data.summary?.headline}</HeadStat>}
      renderRowRight={(row) => <StatusPill status={row.status} />}
      previewNote="Sends 24h after the job is marked complete"
      footer={({ selected, preview, send, data }) => (
        <SingleSendFooter
          section="reviews"
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
