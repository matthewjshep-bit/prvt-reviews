// home/Offers.jsx — existing customers segmented into earned tiers
// (tag: offer-eligible). Standard section layout; the tier shows as the row
// pill and in the preview note; batch row comes from batch:true. Each batch
// recipient gets their own tier's card (data.tier.* injected by the broker).

import React from "react";
import SectionBody from "./SectionBody.jsx";
import { Pill } from "./ui.jsx";

const TIER_VARIANT = { proven: "proven", repeat: "repeat", new: "new" };

export default function Offers({ active, onEdit }) {
  return (
    <SectionBody
      section="offers"
      id="offers"
      active={active}
      onEdit={onEdit}
      title="Offers"
      subtitle="Existing customers, segmented by track record"
      renderRowRight={(row) =>
        row.tier ? <Pill variant={TIER_VARIANT[row.tier.id] || "neutral"}>{row.tier.label}</Pill> : null
      }
      previewNote={(selected) =>
        selected?.tier
          ? `${selected.tier.label} tier · ${selected.tier.terms?.rate || ""} rate · ${selected.tier.terms?.down || ""} down`
          : "Terms pulled per contact from data.tier"
      }
      batchMetric={(s) => <span className="text-gray-500">each contact gets their tier’s card</span>}
    />
  );
}
