// CompanionDeals.jsx — the deals a person is on, under their name in the
// companion window (Matt, 2026-10-19: "it would also be nice to see active
// deals associated with the person on the companion"). Every deal, closed
// included, live first: how they're on it (listing agent, buyer, title,
// lender, a walkthrough, a blast they answered; shared/contact-deals.js), a
// buyer's standing, the deal's stage, and the deal itself a click away.
// Nothing when they're on no deal.

import React, { useState } from "react";
import { ExternalLink } from "lucide-react";
import { contactDealRows, ROLE_LABEL } from "@shared/contact-deals.js";
import { INVESTOR_STATUS_LABEL } from "@shared/offer-status.js";
import { offerEditorUrl } from "./api.js";
import { Pill, StagePill } from "./ui.jsx";

const SHOWN = 3;

const STANDING_CLS = {
  committed: "bg-emerald-100 text-emerald-800",
  soft_commit: "bg-amber-100 text-amber-900",
  passed: "bg-red-100 text-red-700",
};

/** <StandingPill standing /> — a buyer's place on a deal: evaluating, committed… */
export function StandingPill({ standing }) {
  if (!standing?.status) return null;
  return <Pill small label={(INVESTOR_STATUS_LABEL[standing.status] || standing.status).toLowerCase()} cls={STANDING_CLS[standing.status] || "bg-blue-100 text-blue-800"} />;
}

export const dealUrl = (offerId) => `${offerEditorUrl(offerId, { view: "deals" })}&deal_id=${encodeURIComponent(offerId)}`;

/** <CompanionDeals rec /> — rec is the contact record (GET /api/contacts/:id/record). */
export default function CompanionDeals({ rec }) {
  const [all, setAll] = useState(false);
  const rows = contactDealRows(rec);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <div className="mt-2" aria-label="Their deals">
      <ul className="space-y-1">
        {shown.map((r) => (
          <li key={r.offerId} className={`flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1 text-xs ${r.live ? "" : "opacity-60"}`}>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-semibold text-slate-800">{r.address.split(",")[0] || "Untitled"}</span>
              {r.roles.length > 0 && <span className="text-slate-500"> · {r.roles.map((k) => ROLE_LABEL[k] || k).join(", ")}</span>}
            </span>
            <StandingPill standing={r.standing} />
            <StagePill stage={r.stage} small />
            <a href={dealUrl(r.offerId)} target="_blank" rel="noreferrer" title="Open the deal"
              className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-blue-700 hover:underline">
              Deal <ExternalLink size={11} />
            </a>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <button type="button" className="mt-1 text-xs text-blue-700 hover:underline" onClick={() => setAll(true)}>+{rows.length - shown.length} more</button>
      )}
    </div>
  );
}
