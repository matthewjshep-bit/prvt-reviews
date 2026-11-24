// links.js — links between pages that open on their own (the companion at
// /contact, an old GHL menu link). Since 2026-11-23 the console is one shell
// (app-nav.js): Offers, Deals and Luxury up top, the rest under More, so most
// moves are in-page. A link to another page is a full load: carry the
// location scope, drop view-local params (?stage=, ?contact=).

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

// Pages that moved (2026-11-23: Autopilot and Reports went under More in the
// one shell, Lots under Luxury; 2026-10-20: Agent Outreach and Dispositions
// became Autopilot tabs, and Today is gone; 2026-09-13: Overview split into
// Today, Autopilot, Reports). The GHL menu links and bookmarks still say
// /autopilot, /reports, /agents, /dispo and /dashboard; they land where that
// page lives now. Other params (location_id, key, contact) ride along, and
// the shell (app-nav.js resolveView) opens a retired tab's successor.
const underMore = (fallback) => (view) => (view === "lots" ? ["/luxury", "lots"] : ["/", view || fallback]);
const MOVED_PAGES = [
  [/^\/autopilot(\/|$)/, underMore("agents")],
  [/^\/reports(\/|$)/, underMore("flow")],
  [/^\/agents(\/|$)/, () => ["/", "agents"]],
  [/^\/dispo(\/|$)/, () => ["/", "investors"]],
  // Today (the Desk and Tier 1) is gone (Matt, 2026-10-20): the machine works
  // it, Tier 1 is GHL's pipeline. Anything else under /dashboard opens Offers.
  // Its Activity charts went with Reports → Activity (2026-11-23): Flow.
  [/^\/dashboard(\/|$)/, (view) => ({ flow: ["/", "flow"], dashboard: ["/", "flow"], conversation: ["/", "advanced"] })[view] || ["/", "history"]],
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
