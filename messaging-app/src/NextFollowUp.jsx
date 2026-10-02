// NextFollowUp.jsx — the Offers tab's "Next follow-up" cell: when the next
// touch on this offer is, and what it is. The broker computes it
// (shared/next-follow-up.js, GET /api/offers?next=1); this only says it.
//
// Colour carries who acts: sky goes by itself, amber waits for you, rose is
// a live offer with nothing coming (the gap Matt asked to see), grey is
// nothing coming by design (a deal, our pass, a superseded row).

import React from "react";

const DAY_MS = 86400000;
const TZ = "America/Los_Angeles";
const BY_DESIGN = new Set(["deal", "we_passed", "unavailable", "superseded", "draft"]);

const pacificDay = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });

/**
 * whenText(at, now) → "Today" | "Tomorrow" | "Thu" | "Oct 12" | "Overdue 3d"
 *
 * Days, in Pacific time: the sweep that sends a rung runs once each morning,
 * so the hour would be false precision. A queued draft has a real send time
 * and shows it (`withTime`).
 */
export function whenText(at, now = Date.now(), { withTime = false } = {}) {
  const t = Date.parse(at || "");
  if (!Number.isFinite(t)) return "";
  if (t < now - 3600000) {
    const days = Math.floor((now - t) / DAY_MS);
    return days >= 1 ? `Overdue ${days}d` : "Overdue";
  }
  const time = withTime ? ` ${new Date(t).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase()}` : "";
  const today = pacificDay(now);
  const day = pacificDay(t);
  if (day === today) return `Today${time}`;
  if (day === pacificDay(now + DAY_MS)) return `Tomorrow${time}`;
  if (t - now < 6 * DAY_MS) return `${new Date(t).toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" })}${time}`;
  return `${new Date(t).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" })}${time}`;
}

/** A live offer that needs someone to look: nothing coming, or it's late. */
export function needsFollowUp(o, now = Date.now()) {
  const n = o?.nextFollowUp;
  if (!n || n.stale || o.supersededBy || o.status === "draft" || o.deal) return false;
  if (BY_DESIGN.has(n.kind)) return false;
  return n.kind === "none" || (n.at != null && Date.parse(n.at) < now - 3600000);
}

/** The sort key: soonest first, nothing-coming last. */
export const nextSortKey = (o) => (o?.nextFollowUp?.at && !o.nextFollowUp.stale ? o.nextFollowUp.at : null);

/** The agent's soonest, for the group header. A gap outranks a date. */
export function groupNext(offers = []) {
  const live = offers.filter((o) => o?.nextFollowUp && !o.supersededBy && o.status !== "draft");
  const gap = live.find((o) => o.nextFollowUp.kind === "none");
  if (gap) return gap.nextFollowUp;
  return live.filter((o) => o.nextFollowUp.at).sort((a, b) => a.nextFollowUp.at.localeCompare(b.nextFollowUp.at))[0]?.nextFollowUp || null;
}

export default function NextFollowUp({ next, enriched = true, muted = false, now = Date.now() }) {
  if (!enriched || next === undefined) return <span className="text-slate-300">—</span>;
  if (!next) return <span className="text-slate-300">—</span>;
  if (next.stale) return <span className="text-[11px] text-slate-400" title="The status changed; reload to see the new schedule">updates on reload</span>;
  const title = [next.label, next.reason, next.at ? new Date(next.at).toLocaleString("en-US", { timeZone: TZ }) : ""].filter(Boolean).join(" · ");
  if (BY_DESIGN.has(next.kind) || (!next.at && next.kind !== "none")) {
    return <span className="block max-w-[14rem] truncate text-[12px] text-slate-400" title={title}>{next.label}</span>;
  }
  if (next.kind === "none") {
    return <span className="block max-w-[14rem] truncate text-[12px] font-semibold text-rose-600" title={title}>None scheduled</span>;
  }
  const late = Date.parse(next.at) < now - 3600000;
  const tone = late ? "text-rose-600" : next.who === "you" ? "text-amber-700" : "text-sky-700";
  return (
    <span className={`block max-w-[14rem] ${muted ? "opacity-70" : ""}`} title={title}>
      <span className={`whitespace-nowrap font-semibold ${tone}`}>
        {whenText(next.at, now, { withTime: next.kind === "queued" })}
        {next.who === "you" ? " · you" : ""}
      </span>
      <span className="block truncate text-[11px] text-slate-500">{next.label}</span>
    </span>
  );
}
