// MachineTrouble.jsx — one red line at the top of Offers and Deals when the
// machine has stopped something that brings in business (2026-11-23 audit,
// AH-1 and AH-6). The Apify key was rejected for a week before anyone saw
// it: the warning was on Reports → Line and in #machine, which Matt doesn't
// open day to day.
//
// Reads GET /api/dashboard/machine (two small cursors) on open and every ten
// minutes while the page is up. Renders nothing when all is well, or when the
// read fails: this line never gets in the way of the page.

import React, { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { getMachineTrouble } from "./api.js";

export const TROUBLE_POLL_MS = 10 * 60000;

export function troubleLines(r) {
  return (Array.isArray(r?.trouble) ? r.trouble : []).filter((t) => t && t.text).slice(0, 4);
}

/** TroubleLines({ lines }) → the red line(s), or nothing. */
export function TroubleLines({ lines = [] }) {
  if (!lines.length) return null;
  return (
    <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {lines.map((l) => (
        <div key={l.id || l.text} className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

export default function MachineTrouble() {
  const [lines, setLines] = useState([]);
  useEffect(() => {
    let alive = true;
    const read = () => getMachineTrouble().then((r) => { if (alive) setLines(troubleLines(r)); }).catch(() => {});
    read();
    const t = setInterval(read, TROUBLE_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return <TroubleLines lines={lines} />;
}
