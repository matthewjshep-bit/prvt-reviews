// OwnersAnswered.jsx — the Luxury page's "Owners who answered" strip
// (2026-11-24). A homeowner who answers a lot text is Matt's call: he prices
// every lot himself, and the Desk row that used to say "call now" is gone.
// This lists each owner who answered with no lot offer from him yet, newest
// first; a name opens their record. One cheap read
// (GET /api/lot-finder/answered); nothing here sends anything.

import React, { useEffect, useState } from "react";
import { PhoneCall } from "lucide-react";
import { getAnsweredLotOwners } from "./api.js";
import ContactLink from "./ContactLink.jsx";
import { ago } from "./ui.jsx";

/** The strip itself, from the rows (exported for the test). Nothing when no one is waiting. */
export function OwnersAnsweredStrip({ owners = [] }) {
  if (!owners.length) return null;
  return (
    <section aria-label="Owners who answered" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
        <PhoneCall size={15} aria-hidden="true" />
        <span>Owners who answered · {owners.length}</span>
        <span className="font-normal text-amber-800">yours to call and price</span>
      </div>
      <ul className="mt-2 flex flex-wrap gap-2">
        {owners.map((o) => (
          <li key={o.contactId} className="flex min-w-0 items-center gap-1.5 rounded-full border border-amber-200 bg-white px-3 py-1 text-sm text-slate-700">
            <ContactLink contactId={o.contactId} name={o.name || o.street || "Lot owner"} party="owner" className="font-medium text-slate-900" />
            {o.name && o.street && <span className="truncate text-slate-500">{o.street}</span>}
            <span className="whitespace-nowrap text-xs text-slate-400">{ago(o.at)}{o.replies > 1 ? ` · ${o.replies} texts` : ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function OwnersAnswered() {
  const [owners, setOwners] = useState([]);
  useEffect(() => {
    let live = true;
    getAnsweredLotOwners().then((r) => { if (live) setOwners(Array.isArray(r?.owners) ? r.owners : []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return <OwnersAnsweredStrip owners={owners} />;
}
