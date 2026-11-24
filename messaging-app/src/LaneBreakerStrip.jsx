// LaneBreakerStrip — one line per machine lane the lane breaker stopped
// (ghl-broker/lane-breaker.js, 2026-11-23): its texts came back
// carrier-blocked (30007) or STOPped, so its queued texts went back to drafts
// and nothing more of that kind sends by itself. "Let it send again" is
// Matt's one click: the lane is judged afresh from then, and texts it held in
// the last four days go back on their clock across the machine's day (older
// ones stay in the Outbox for a hand Send). The click itself sends nothing.
// Shows nothing while no lane is stopped.

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

const texts = (n) => (n === 1 ? "1 text" : `${n} texts`);

/** clearedLine({ released, rescheduled }) → what one click did, in counts. */
export function clearedLine(r = {}) {
  const released = Number(r.released) || 0;
  const back = Math.min(Number(r.rescheduled) || 0, released);
  const waiting = released - back;
  const parts = [];
  if (back) parts.push(`${texts(back)} ${back === 1 ? "is" : "are"} back on the clock`);
  if (waiting) parts.push(`${texts(waiting)} ${waiting === 1 ? "waits" : "wait"} in the Outbox for your Send`);
  return parts.length ? `${parts.join("; ")}.` : "Cleared.";
}

export default function LaneBreakerStrip() {
  const [trips, setTrips] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [done, setDone] = useState("");

  useEffect(() => {
    let live = true;
    getLaneBreaker().then((r) => { if (!live) return; setTrips(Array.isArray(r?.trips) ? r.trips : []); setEnabled(r?.enabled !== false); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!trips.length && !done) return null;

  const clear = async (kind) => {
    setBusy(kind);
    setError("");
    try {
      const r = await clearLaneBreaker(kind, { backOnClock: true });
      setTrips((ts) => ts.filter((t) => t.kind !== kind));
      setDone(clearedLine(r));
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
            title="The lane may send by itself again. Texts it held in the last four days go back on their clock; older ones wait in the Outbox. Nothing is sent by this click.">
            {busy === t.kind ? "Clearing…" : "Let it send again"}
          </button>
        </div>
      ))}
      {!enabled && trips.length > 0 && <div className="text-xs text-amber-700">The lane breaker is switched off, so nothing new is being held; these lanes stay stopped until you let them go.</div>}
      {done && <div className="text-xs text-amber-800">{done}</div>}
      {error && <div className="text-xs text-red-700">{error}</div>}
    </div>
  );
}
