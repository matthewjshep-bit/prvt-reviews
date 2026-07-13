// home/Reviews.jsx — recently completed jobs awaiting a review ask
// (tag: review-due), freshest first. Standard section layout; single-send.

import React from "react";
import SectionBody from "./SectionBody.jsx";
import { StatusPill } from "./ui.jsx";

export default function Reviews({ active, onEdit }) {
  return (
    <SectionBody
      section="reviews"
      id="reviews"
      active={active}
      onEdit={onEdit}
      title="Reviews"
      subtitle="Ask while the job is still fresh"
      renderRowRight={(row) => <StatusPill status={row.status} />}
      previewNote="Sends 24h after the job is marked complete"
    />
  );
}
