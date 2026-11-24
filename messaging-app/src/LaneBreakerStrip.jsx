// LaneBreakerStrip — one line per machine lane the lane breaker stopped
// (ghl-broker/lane-breaker.js, 2026-11-23): its texts came back
// carrier-blocked (30007) or STOPped, so its queued texts went back to drafts
// and nothing more of that kind sends by itself. "Let it send again" is
// Matt's one click: the lane is judged afresh from then. It schedules and
// sends nothing. Shows nothing while no lane is stopped.

import { useEffect, useState } from "react";
import { getLaneBreaker, clearLaneBreaker } from "./api.js";
import { BTN, ago } from "./ui.jsx";

/** tripLine(trip) → the strip's words for one stopped lane. Counts only. */
export function tripLine(t = {}) {
  const why = String(t.why || "").trim();
  const held = Number(t.held) || 0;
  const queued = held ? ` ${held === 1 ? "1 queued text" : `${held} queued texts`} went back to drafts.` : "";
  return `${t.label || "A lane"} stopped${why ? `: ${why}` : ""}.${queued}`;
}

export default function LaneBreakerStrip() {
  const [trips, setTrips] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    getLaneBreaker().then((r) => { if (live) setTrips(Array.isArray(r?.trips) ? r.trips : []); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!trips.length) return null;

  const clear = async (kind) => {
    setBusy(kind);
    setError("");
    try {
      await clearLaneBreaker(kind);
      setTrips((ts) => ts.filter((t) => t.kind !== kind));
    } catch (e) {
      setError(e.message || "couldn't clear it");
    } finally {
      setBusy("");
    }
  };

  return (
    <div role="status" className="mb-3 space-y-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {trips.map((t) => (
        <div key={t.kind} className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Lane breaker</span>
          <span className="min-w-0 flex-1">{tripLine(t)} {t.at ? <span className="text-amber-700">({ago(t.at)})</span> : null}</span>
          <button type="button" className={BTN} disabled={busy === t.kind} onClick={() => clear(t.kind)}
            title="The lane may send by itself again. The held drafts stay drafts; nothing is sent by this click.">
            {busy === t.kind ? "Clearing…" : "Let it send again"}
          </button>
        </div>
      ))}
      {error && <div className="text-xs text-red-700">{error}</div>}
    </div>
  );
}
