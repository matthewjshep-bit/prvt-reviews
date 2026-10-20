// autopilot-overview.js — Autopilot's front page in a few numbers
// (2026-10-20).
//
// Matt: "I just want to be able to go on autopilot and see, at a very
// high-level glance, what our system, our app, is doing … what has been sent
// out to agents and investors, what is going to be sent out, and just
// numbers … Minimalist is the main key." The counts are Reports →
// Follow-up's own (shared/follow-up-engine.js, GET /api/dashboard/followup):
// every text the app starts by itself, by the mechanism that sends it, sent
// and coming. This folds them into two sides, agents and buyers, and keeps
// only the lines that have something on them.
//
// Pure.

// Which side each follow-up group is on.
export const OVERVIEW_SIDES = [
  { key: "agents", label: "Agents", groups: ["outreach", "agent", "offer_live", "offer_passed"] },
  { key: "investors", label: "Investors", groups: ["buyer"] },
];
// The names the Agents and Investors charts use, so the front page and the
// charts say the same thing; anything else keeps Reports' name.
export const OVERVIEW_LABELS = {
  outreach_open: "First text", outreach_nudge: "Follow-ups", agent_pulse: "Check-ins",
  blast_first: "Deal text · wave 1", blast_wave: "Deal text · later waves", deal_followup: "Deal follow-up",
  buyer_pulse: "Check-ins", showing: "Walkthrough reminders",
};
// The lines a side shows before the rest fold into "Everything else".
export const OVERVIEW_MAX_LINES = 5;

/**
 * autopilotOverview(page) → { period, sides: [{ key, label, sent, replied, coming, waiting, lines, next }] }
 *
 * `page` is the follow-up engine's page. `sent` counts every text a side's
 * machines sent in the period, first texts and deal texts included; `coming`
 * is what's written with a send time plus what the next sweeps would start;
 * `waiting` is a machine draft held for a person. `lines` are its
 * mechanisms with anything on them, busiest first; `next` is the soonest
 * text coming.
 */
export function autopilotOverview(page = {}) {
  const groups = Array.isArray(page.groups) ? page.groups : [];
  const sides = OVERVIEW_SIDES.map((side) => {
    const mechs = groups.filter((g) => side.groups.includes(g.key)).flatMap((g) => g.mechanisms || []);
    const line = (m) => ({ key: m.key, label: OVERVIEW_LABELS[m.key] || m.label, sent: num(m.sent), coming: num(m.queued) + num(m.planned), waiting: num(m.held), status: m.status || "off", next: m.next || null });
    const active = mechs.map(line).filter((l) => l.sent || l.coming || l.waiting)
      .sort((a, b) => (b.sent + b.coming + b.waiting) - (a.sent + a.coming + a.waiting) || a.label.localeCompare(b.label));
    const shown = active.slice(0, OVERVIEW_MAX_LINES);
    const rest = active.slice(OVERVIEW_MAX_LINES);
    const lines = rest.length
      ? [...shown, { key: "other", label: "Everything else", sent: total(rest, "sent"), coming: total(rest, "coming"), waiting: total(rest, "waiting"), status: "", next: null }]
      : shown;
    const next = active.filter((l) => l.next?.at).map((l) => ({ ...l.next, label: l.label }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] || null;
    return {
      key: side.key, label: side.label,
      sent: total(active, "sent"), replied: mechs.reduce((a, m) => a + num(m.replied), 0),
      coming: total(active, "coming"), waiting: total(active, "waiting"),
      lines, next,
    };
  });
  return { period: page.period || "week", sides };
}

const num = (v) => Math.max(0, Number(v) || 0);
const total = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
