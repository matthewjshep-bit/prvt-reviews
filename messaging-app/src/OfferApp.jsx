// OfferApp.jsx — the console's one shell (2026-11-23 audit, nav-1).
//
// Matt works two pages: Offers and Deals. Those, and Luxury (the teardown
// lane he keeps separate), are the pills up top; everything that runs in
// the background sits under one More menu (app-nav.js):
//   Offers    every offer for the location, grouped by agent, with its
//             outcome. The landing view: the daily job is working the list.
//   Deals     offers under signed contract, tracked through disposition.
//   Luxury    the same Offers and Deals narrowed to luxury lots, plus Lots
//             (the lot finder), at /luxury.
//   More      Machine: Agent texts, Investor texts, Gatekeepers, Autopilot
//             settings, Settings. Reports: Flow, Line, Follow-up, Lessons.
//             And the Companion window to keep beside GHL.
// New Offer is the header's button, not a tab.
//
// /autopilot, /reports, /agents, /dispo and /dashboard are old GHL menu
// links: links.js movedTo sends each to its view here. /deals still shows
// every kind of deal; /contact is the companion window on its own.

import React, { useEffect, useState } from "react";
import { ChevronDown, PanelRight, Plus } from "lucide-react";
import { brandMarkSvg } from "@shared/brand-mark.js";
import NewOffer from "./NewOffer.jsx";
import OffersHistory from "./OffersHistory.jsx";
import DealsView from "./DealsView.jsx";
import AgentOutreach from "./AgentOutreach.jsx";
import Dispositions from "./Dispositions.jsx";
import DispoImport from "./DispoImport.jsx";
import SettingsView from "./SettingsView.jsx";
import ConversationAi from "./ConversationAi.jsx";
import FlowView from "./FlowView.jsx";
import LineView from "./LineView.jsx";
import FollowUpView from "./FollowUpView.jsx";
import AutopilotView from "./AutopilotView.jsx";
import LastNightPanel from "./LastNightCard.jsx";
import CoachCard from "./CoachCard.jsx";
import AgentsTab from "./AgentsTab.jsx";
import GatekeepersTab from "./GatekeepersTab.jsx";
import LotsTab from "./LotsTab.jsx";
import { isLuxuryLot } from "@shared/asset-type.js";
import InvestorsTab from "./InvestorsTab.jsx";
import LessonsTab from "./LessonsTab.jsx";
import ContactDrawer from "./ContactDrawer.jsx";
import CompanionView from "./CompanionView.jsx";
import { COMPANION_WINDOW } from "./companion.js";
import { appHref, movedTo } from "./links.js";
import { ContactDrawerContext } from "./ContactLink.jsx";
import { getLocationId, getNeedsMatt, getOffer, getSettings } from "./api.js";
import { LUXURY_TABS, MORE, PILLS, activePill, laneFilter, moreLabel, resolveView, routeOf, urlFor } from "./app-nav.js";
import { useLightPoll } from "./light-poll.js";
import { Menu, NeedsChip } from "./ui.jsx";

// A page that moved (links.js movedTo): the GHL menu links still say
// /autopilot, /reports, /agents, /dispo and /dashboard. A forced mode is its
// own deploy and stays where it is.
const FORCED = (() => { try { return import.meta.env.VITE_APP_MODE || ""; } catch { return ""; } })();
(() => {
  if (FORCED) return;
  try {
    const to = movedTo(window.location.pathname, window.location.search);
    if (to) window.location.replace(to);
  } catch { /* stay where we are */ }
})();

// The companion window beside GHL (CompanionView.jsx) is its own page.
const IS_COMPANION = (() => { try { return /^\/contact(\/|$)/.test(window.location.pathname); } catch { return false; } })();

// VITE_APP_MODE can still force one product onto a dedicated-domain deploy
// (RUNBOOK "Step 3"). Outreach and Dispositions keep their old tabs there;
// none is set on the Netlify site today.
const LEGACY_NAV = FORCED === "outreach"
  ? [{ view: "outreach", label: "Agents" }, { view: "settings", label: "Settings" }]
  : FORCED === "dispo"
  ? [{ view: "dispo", label: "Investors" }, { view: "import", label: "Import buyers" }, { view: "settings", label: "Settings" }]
  : null;

function readParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name) || "";
  } catch {
    return "";
  }
}

function initialRoute() {
  if (LEGACY_NAV) {
    const v = readParam("view");
    return { lane: "agents", view: LEGACY_NAV.some((n) => n.view === v) ? v : LEGACY_NAV[0].view };
  }
  try {
    if (FORCED === "autopilot" && !readParam("view")) return resolveView("agents", "agents");
    if (FORCED === "reports" && !readParam("view")) return resolveView("agents", "flow");
    return routeOf(window.location.pathname, window.location.search);
  } catch {
    return { lane: "agents", view: "history" };
  }
}

const sameRoute = (a, b) => a?.lane === b?.lane && a?.view === b?.view;

// The console wears the same lockup as the investor pages — the operator's
// mark and wordmark, in their colors, from the same settings blob. It keeps
// its own tabs: this is the tool, not the shopfront.
function BrandLockup({ settings, fallback }) {
  const co = settings?.company || {};
  const wordmark = (co.wordmark || co.name || "").trim();
  if (!wordmark) return <span className="text-sm font-bold tracking-tight">{fallback}</span>;
  const primary = co.brandPrimary || "#16294A";
  return (
    <span className="flex items-center gap-2" title={fallback}>
      {co.logoUrl
        ? <img src={co.logoUrl} alt="" height={22} className="h-[22px] w-auto" />
        : <span className="flex items-center"
            dangerouslySetInnerHTML={{
              __html: brandMarkSvg({ primary, accent: co.brandAccent, height: 22 }),
            }} />}
      <span className="whitespace-nowrap text-[13px] font-bold uppercase leading-none tracking-[0.14em]"
        style={{ color: primary }}>
        {wordmark.split("·").map((part, i, all) => (
          <React.Fragment key={i}>
            {part}
            {i < all.length - 1 && <span style={{ color: co.brandAccent || "#B8922E" }}>·</span>}
          </React.Fragment>
        ))}
      </span>
    </span>
  );
}

const PILL = "whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors";
const pillTone = (on) => (on ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100");

export default function OfferApp() {
  const [route, setRouteState] = useState(initialRoute);
  const { lane, view } = route;
  const [initialContactId, setInitialContactId] = useState(() => readParam("contact_id"));
  const [editing, setEditing] = useState(null); // draft/offer being reopened in the form
  const [formNonce, setFormNonce] = useState(0); // bump to remount NewOffer blank
  const go = (next) => setRouteState((cur) => {
    const r = LEGACY_NAV ? { lane: "agents", view: next.view } : resolveView(next.lane ?? cur.lane, next.view);
    return sameRoute(cur, r) ? cur : r;
  });

  const resetForm = () => {
    setEditing(null);
    setInitialContactId(""); // a deep-linked contact stays only for the first form
    setFormNonce((n) => n + 1);
    try { window.scrollTo({ top: 0 }); } catch { /* noop */ }
  };
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState("");
  // The contact drawer: one person's whole record, opened from any name in
  // any view. Lives here, outside the view switch, so every host has it.
  // ?contact=<id> deep-links to it (distinct from ?contact_id=, which
  // prefills the New Offer form).
  const [contact, setContact] = useState(() => { const id = readParam("contact"); return id ? { id, party: null } : null; });
  const drawer = React.useMemo(() => ({
    open: (id, { party = null, name = null } = {}) => {
      setContact({ id, party, name });
      try { const p = new URLSearchParams(window.location.search); p.set("contact", id); window.history.replaceState(window.history.state, "", `${window.location.pathname}?${p}`); } catch { /* noop */ }
    },
    close: () => {
      setContact(null);
      try { const p = new URLSearchParams(window.location.search); p.delete("contact"); window.history.replaceState(window.history.state, "", `${window.location.pathname}?${p}`); } catch { /* noop */ }
    },
  }), []);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) => setSettingsError(e.message));
  }, []);

  // Who is on GHL's Needs Matt stage (needs-view.js): one cursor read on load
  // and a light re-read now and then while the tab shows. The pages put the
  // reason on each row and say how many of theirs are on it.
  const shell = !LEGACY_NAV && !IS_COMPANION;
  const [needs, setNeeds] = useState([]);
  const [needCounts, setNeedCounts] = useState({ offers: 0, deals: 0 });
  const [needsFocus, setNeedsFocus] = useState(null); // "offers" | "deals": filter that page to them once
  const loadNeeds = () => getNeedsMatt().then(setNeeds).catch(() => { /* the rows just carry no reason */ });
  useEffect(() => { if (shell) loadNeeds(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useLightPoll(loadNeeds, { enabled: shell });
  const reportNeeds = React.useCallback((counts) => setNeedCounts((cur) => ({ ...cur, ...counts })), []);
  const reportDealNeeds = React.useCallback((n) => setNeedCounts((cur) => ({ ...cur, deals: n })), []);
  const needsFocused = React.useCallback(() => setNeedsFocus(null), []);

  // Push each page onto history so Back works and any page can be linked to:
  // the lane is the path (/, /luxury, /deals), the page is ?view=.
  // replaceState on the first render (there's nothing to go back to yet);
  // pushState after, and popstate restores whatever the user came from.
  const firstRender = React.useRef(true);
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const url = LEGACY_NAV ? (p.set("view", view), `${window.location.pathname}?${p}`) : urlFor(route, window.location.search);
      if (firstRender.current) window.history.replaceState({ ...route }, "", url);
      else if (!sameRoute(window.history.state, route)) window.history.pushState({ ...route }, "", url);
    } catch { /* iframe history can be restricted — the app still works */ }
    firstRender.current = false;
  }, [lane, view]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPop = (e) => {
      if (LEGACY_NAV) { const v = e.state?.view || readParam("view"); if (LEGACY_NAV.some((n) => n.view === v)) setRouteState({ lane: "agents", view: v }); return; }
      setRouteState(e.state?.view ? resolveView(e.state.lane, e.state.view) : routeOf(window.location.pathname, window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Deep link from the GHL contact note: ?offer_id= reopens that offer in the
  // editor once it loads.
  useEffect(() => {
    if (LEGACY_NAV) return; // offers-only deep link
    const offerId = readParam("offer_id");
    if (!offerId) return;
    getOffer(offerId)
      .then((o) => { if (o) { setEditing(o); go({ view: "new" }); } })
      .catch(() => { /* wrong location or deleted offer — stay on the blank form */ });
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!getLocationId()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-center text-slate-600">
        <div>
          <div className="text-lg font-semibold text-slate-900">Missing location</div>
          <p className="mt-1 text-sm">Open this page from its GHL menu link so ?location_id= is set.</p>
        </div>
      </div>
    );
  }

  // The companion window is its own page: no tabs, no drawer (the record is
  // on the page), the location gate above all the same.
  if (IS_COMPANION) return <CompanionView settings={settings} />;

  const only = laneFilter(lane, isLuxuryLot);
  const title = LEGACY_NAV ? (FORCED === "outreach" ? "Agent Outreach" : "Dispositions")
    : lane === "luxury" ? "Luxury" : lane === "all" ? "Deals" : "Offer Generator";
  const pill = activePill(route);
  const inMore = !LEGACY_NAV && MORE.some((m) => m.view === view);
  const openCompanion = () => window.open(appHref("/contact"), COMPANION_WINDOW, "popup,width=560,height=900");
  const moreItems = [
    ...MORE.map((m) => (m.heading ? { heading: m.heading, key: `h-${m.heading}` }
      : { key: m.view, label: m.label, selected: view === m.view, onSelect: () => go({ lane: "agents", view: m.view }) })),
    { heading: "Beside GHL", key: "h-companion" },
    { key: "companion", label: "Companion window", icon: <PanelRight size={13} aria-hidden="true" />,
      title: "Open a window to keep beside GoHighLevel: it shows whoever you open there", onSelect: openCompanion },
  ];
  const focusNeeds = (page) => {
    setNeedsFocus(page);
    go(page === "deals" ? { lane: lane === "all" ? "all" : "agents", view: "deals" } : { lane: "agents", view: "history" });
  };
  const editOffer = (o) => { setEditing(o); go({ view: "new" }); };

  // New Offer keeps a centered cap (the form reads better constrained); the
  // table-heavy views run full-bleed to use the GHL iframe's width. Header and
  // content share the class so their edges always align.
  const containerWidth = view === "new" ? "mx-auto max-w-7xl" : "";

  return (
    <ContactDrawerContext.Provider value={drawer}>
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {contact && <ContactDrawer contactId={contact.id} party={contact.party} onClose={drawer.close} />}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        {/* Wraps on a phone: the lockup and New Offer on the first line, the
            pages on a line of their own below (nav-11). */}
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6 lg:px-8 ${containerWidth}`}>
          <div className="mr-1 flex min-w-0 items-center gap-2.5">
            <BrandLockup settings={settings} fallback={title} />
            {/* Without a wordmark the lockup already is the title — don't say it twice. */}
            {(settings?.company?.wordmark || settings?.company?.name || "").trim() &&
              <span className="hidden text-sm font-semibold text-slate-400 lg:inline">{title}</span>}
          </div>
          <nav aria-label="Pages" className="order-last flex w-full min-w-0 items-center gap-1.5 overflow-x-auto sm:order-none sm:w-auto sm:overflow-visible">
            {LEGACY_NAV ? LEGACY_NAV.map((n) => (
              <button key={n.view} type="button" onClick={() => go({ view: n.view })}
                aria-current={n.view === view ? "page" : undefined} className={`${PILL} ${pillTone(n.view === view)}`}>
                {n.label}
              </button>
            )) : (<>
              {PILLS.map((p) => (
                <span key={p.key} className="inline-flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => go({ lane: p.key === "deals" && lane === "all" ? "all" : p.lane, view: p.view })}
                    aria-current={pill === p.key ? "page" : undefined} className={`${PILL} ${pillTone(pill === p.key)}`}>
                    {p.label}
                  </button>
                  {p.key === "offers" && <NeedsChip count={needCounts.offers} page="Offers" onClick={() => focusNeeds("offers")} />}
                  {p.key === "deals" && <NeedsChip count={needCounts.deals} page="Deals" onClick={() => focusNeeds("deals")} />}
                </span>
              ))}
              <Menu label="More pages" align="left" items={moreItems}
                trigger={<span className={`inline-flex shrink-0 items-center gap-1 ${PILL} ${pillTone(inMore)}`}>
                  {inMore ? `More · ${moreLabel(view)}` : "More"} <ChevronDown size={13} aria-hidden="true" />
                </span>} />
            </>)}
          </nav>
          {!LEGACY_NAV && (
            <button
              type="button"
              onClick={() => { setEditing(null); go({ lane: lane === "all" ? "agents" : lane, view: "new" }); }}
              aria-current={view === "new" ? "page" : undefined}
              className={`ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors ${
                view === "new"
                  ? "bg-blue-700 text-white"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              <Plus size={15} aria-hidden="true" /> New Offer
            </button>
          )}
        </div>
      </header>
      <div className={`px-4 py-6 sm:px-6 lg:px-8 ${containerWidth}`}>
        {settingsError && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            Couldn't load saved settings ({settingsError}) — using defaults.
          </div>
        )}
        {lane === "luxury" && view !== "new" && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Luxury pages">
            {LUXURY_TABS.map((t) => (
              <button key={t.view} type="button" onClick={() => go({ lane: "luxury", view: t.view })}
                aria-current={view === t.view ? "page" : undefined}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${view === t.view ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        {view === "new" && (
          <NewOffer
            key={editing?.id || `blank-${formNonce}`}
            settings={settings}
            initialContactId={initialContactId}
            restore={editing}
            onReset={resetForm}
            onSettingsSaved={(s) => setSettings(s)}
            // Switching to another of the agent's offers remounts the form on
            // that offer (the key is the offer id), so the outgoing form
            // still flushes its draft on unmount.
            onOpenOffer={(o) => { setEditing(o); try { window.scrollTo({ top: 0 }); } catch { /* noop */ } }}
            // A save in place keeps the same id, so the key doesn't change and
            // the form isn't remounted — this only re-points `restore` at the
            // saved row, which is what the Offer details popout reads.
            onOfferSaved={(o) => setEditing((cur) => (cur && cur.id === o.id ? o : cur))}
            onDeal={() => go({ view: "deals" })}
            // On the Luxury page a new offer starts as a luxury lot, priced by the lot.
            startLane={lane === "luxury" ? "luxury" : ""}
          />
        )}
        {view === "history" && (
          <OffersHistory key={lane} onEdit={editOffer}
            onNew={(contactId) => { setEditing(null); setInitialContactId(contactId); setFormNonce((n) => n + 1); go({ view: "new" }); }}
            onDeal={() => go({ view: "deals" })} settings={settings} only={only}
            needs={lane === "agents" ? needs : []}
            onNeedsCount={lane === "agents" ? reportNeeds : null}
            focusNeeds={lane === "agents" && needsFocus === "offers"} onNeedsFocused={needsFocused} />
        )}
        {view === "deals" && (
          <DealsView key={lane} settings={settings} only={only} onEdit={editOffer}
            needs={lane === "luxury" ? [] : needs}
            onNeedsCount={lane === "luxury" ? null : reportDealNeeds}
            focusNeeds={lane !== "luxury" && needsFocus === "deals"} onNeedsFocused={needsFocused} />
        )}
        {/* The dial and every switch, last night's audit with its Run now,
            and the coach's proposals (moved off Reports → Activity and
            Autopilot → Overview, both retired 2026-11-23), then the bot. */}
        {view === "advanced" && (
          <div className="space-y-6">
            <AutopilotView />
            <LastNightPanel />
            <CoachCard />
            <ConversationAi settings={settings} />
          </div>
        )}
        {view === "agents" && <AgentsTab settings={settings} onSettingsSaved={(s) => setSettings(s)} />}
        {view === "gatekeepers" && <GatekeepersTab />}
        {view === "lots" && <LotsTab />}
        {view === "investors" && <InvestorsTab settings={settings} onSettingsSaved={(s) => setSettings(s)} />}
        {view === "lessons" && <LessonsTab onSettingsSaved={(s) => setSettings(s)} />}
        {view === "flow" && <FlowView />}
        {view === "line" && <LineView />}
        {view === "followup" && <FollowUpView />}
        {view === "outreach" && <AgentOutreach settings={settings} />}
        {view === "dispo" && <Dispositions />}
        {view === "import" && <DispoImport />}
        {view === "settings" && (
          <SettingsView settings={settings} onSaved={(s) => setSettings(s)} mode={LEGACY_NAV ? FORCED : "offers"} />
        )}
      </div>
    </div>
    </ContactDrawerContext.Provider>
  );
}
