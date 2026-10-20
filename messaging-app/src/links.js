// links.js — links between the sibling apps (/dashboard, /autopilot,
// /reports, ...). Each is its own GHL menu link, so a cross-app link is a
// full page load: carry the location scope, drop view-local params (?stage=,
// ?contact=) that mean nothing on the other page.

export function appHref(path, view) {
  try {
    const cur = new URLSearchParams(window.location.search);
    const p = new URLSearchParams();
    for (const k of ["location_id", "key"]) if (cur.get(k)) p.set(k, cur.get(k));
    if (view) p.set("view", view);
    return `${path}?${p}`;
  } catch {
    return view ? `${path}?view=${view}` : path;
  }
}

// Pages that moved (2026-10-20: Agent Outreach and Dispositions became tabs
// of Autopilot; 2026-09-13: Overview split into Today, Autopilot, Reports).
// The GHL menu links and bookmarks still say /agents, /dispo and
// /dashboard?view=flow; they land where that page lives now. Other params
// (location_id, key, contact) ride along.
const MOVED_PAGES = [
  [/^\/agents(\/|$)/, () => ["/autopilot", "agents"]],
  [/^\/dispo(\/|$)/, () => ["/autopilot", "investors"]],
  [/^\/dashboard(\/|$)/, (view) => ({ flow: ["/reports", "flow"], dashboard: ["/reports", "activity"], conversation: ["/autopilot", "bot"] })[view] || null],
];

/** movedTo(pathname, search) → the URL that page lives at now, or null. */
export function movedTo(pathname = "", search = "") {
  const p = new URLSearchParams(search);
  for (const [rx, to] of MOVED_PAGES) {
    if (!rx.test(pathname)) continue;
    const dest = to(p.get("view"));
    if (!dest) return null;
    p.set("view", dest[1]);
    return `${dest[0]}?${p}`;
  }
  return null;
}
