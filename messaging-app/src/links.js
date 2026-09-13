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
