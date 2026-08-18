// OfferApp.jsx — the offer generator shell. Four views:
//   Offers    — every offer created for this location, grouped by agent, with
//               its outcome. The landing view: the daily job is working the
//               list, so the list is home and creating is an action off it.
//   New Offer — pick a contact, enter property numbers, get three offers,
//               generate the document, attach it to the contact record.
//               Reached from the header button, not a tab.
//   Deals     — offers under signed contract, tracked through disposition.
//   Settings  — calculation defaults + company info printed on the document.
// Plus three sibling apps on their own paths: /agents, /dashboard, /dispo.

import React, { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { brandMarkSvg } from "@shared/brand-mark.js";
import NewOffer from "./NewOffer.jsx";
import OffersHistory from "./OffersHistory.jsx";
import DealsView from "./DealsView.jsx";
import AgentOutreach from "./AgentOutreach.jsx";
import Dispositions from "./Dispositions.jsx";
import Dashboard from "./Dashboard.jsx";
import SettingsView from "./SettingsView.jsx";
import { getLocationId, getLocationKey, getOffer, getSettings } from "./api.js";

// The offer editor lives in the main app — from the standalone Deals page,
// "Edit offer" opens it in a new tab deep-linked via the ?offer_id= flow.
function offerEditorUrl(offerId) {
  const p = new URLSearchParams({ location_id: getLocationId(), offer_id: offerId });
  const key = getLocationKey();
  if (key) p.set("key", key);
  return `/?${p}`;
}

// Which product this page is. One deploy serves all five: /agents (any depth)
// is the Agent Outreach app, /dispo is the investor book, /dashboard is the
// analytics Dashboard, /deals is the standalone Deals board, everything else is
// the offer generator. The Netlify SPA redirect sends every path to this same
// bundle; VITE_APP_MODE still forces a mode for a dedicated-domain deploy.
const APP_MODE = (() => {
  try {
    if (import.meta.env.VITE_APP_MODE === "outreach") return "outreach";
    if (import.meta.env.VITE_APP_MODE === "dashboard") return "dashboard";
    if (import.meta.env.VITE_APP_MODE === "dispo") return "dispo";
    if (/^\/dashboard(\/|$)/.test(window.location.pathname)) return "dashboard";
    if (/^\/deals(\/|$)/.test(window.location.pathname)) return "deals";
    if (/^\/dispo(\/|$)/.test(window.location.pathname)) return "dispo";
    return /^\/agents(\/|$)/.test(window.location.pathname) ? "outreach" : "offers";
  } catch {
    return "offers";
  }
})();

const NAV =
  APP_MODE === "outreach"
    ? [
        { view: "outreach", label: "Agents" },
        { view: "settings", label: "Settings" },
      ]
    : APP_MODE === "dispo"
    ? [
        { view: "dispo", label: "Investors" },
        { view: "settings", label: "Settings" },
      ]
    : APP_MODE === "dashboard"
    ? [{ view: "dashboard", label: "Dashboard" }]
    : APP_MODE === "deals"
    ? [{ view: "deals", label: "Deals" }]
    : [
        { view: "history", label: "Offers" },
        { view: "deals", label: "Deals" },
        { view: "settings", label: "Settings" },
      ];

const APP_TITLE =
  APP_MODE === "outreach" ? "Agent Outreach"
  : APP_MODE === "dashboard" ? "Dashboard"
  : APP_MODE === "deals" ? "Deals"
  : APP_MODE === "dispo" ? "Dispositions"
  : "Offer Generator";

// "new" is reachable but not a tab — it's the primary button in the header and
// the target of the ?offer_id= deep link, so it still has to be a valid view.
const VIEWS = new Set([...NAV.map((n) => n.view), "new"]);

function readParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name) || "";
  } catch {
    return "";
  }
}

// Keep the URL honest about which view is showing. Until now the URL never
// changed, so the browser back button did nothing and no view but the first
// could be linked to — both of which read as the app being broken.
function viewUrl(view) {
  const p = new URLSearchParams(window.location.search);
  p.set("view", view);
  return `${window.location.pathname}?${p}`;
}

// The console wears the same lockup as the investor pages — the operator's
// mark and wordmark, in their colors, from the same settings blob. It keeps
// its own tabs: this is the tool, not the shopfront, and swapping working
// navigation for marketing links would cost the day's job to gain a logo.
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

export default function OfferApp() {
  const [view, setView] = useState(() => {
    const v = readParam("view");
    return VIEWS.has(v) ? v : NAV[0].view;
  });
  const [initialContactId, setInitialContactId] = useState(() => readParam("contact_id"));
  const [editing, setEditing] = useState(null); // draft/offer being reopened in the form
  const [formNonce, setFormNonce] = useState(0); // bump to remount NewOffer blank

  const resetForm = () => {
    setEditing(null);
    setInitialContactId(""); // a deep-linked contact stays only for the first form
    setFormNonce((n) => n + 1);
    try { window.scrollTo({ top: 0 }); } catch { /* noop */ }
  };
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) => setSettingsError(e.message));
  }, []);

  // Push each view onto history so Back works and any view can be linked to.
  // replaceState on the first render (there's nothing to go back to yet);
  // pushState after, and popstate restores whatever the user came from.
  const firstRender = React.useRef(true);
  useEffect(() => {
    try {
      const url = viewUrl(view);
      if (firstRender.current) window.history.replaceState({ view }, "", url);
      else if (window.history.state?.view !== view) window.history.pushState({ view }, "", url);
    } catch { /* iframe history can be restricted — the app still works */ }
    firstRender.current = false;
  }, [view]);

  useEffect(() => {
    const onPop = (e) => {
      const v = e.state?.view || readParam("view");
      if (VIEWS.has(v)) setView(v);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Deep link from the GHL contact note: ?offer_id= reopens that offer in the
  // editor (same path as History → Edit) once it loads.
  useEffect(() => {
    if (APP_MODE === "outreach" || APP_MODE === "dispo") return; // offers-only deep link
    const offerId = readParam("offer_id");
    if (!offerId) return;
    getOffer(offerId)
      .then((o) => { if (o) { setEditing(o); setView("new"); } })
      .catch(() => { /* wrong location or deleted offer — stay on the blank form */ });
  }, []);

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

  // New Offer keeps a centered cap (the form reads better constrained); the
  // table-heavy views run full-bleed to use the GHL iframe's width. Header and
  // content share the class so their edges always align.
  const containerWidth = view === "new" ? "mx-auto max-w-7xl" : "";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className={`flex items-center gap-3 px-4 py-2.5 sm:px-6 lg:px-8 ${containerWidth}`}>
          <div className="mr-2 flex items-center gap-2.5">
            <BrandLockup settings={settings} fallback={APP_TITLE} />
            <span className="hidden text-sm font-semibold text-slate-400 sm:inline">{APP_TITLE}</span>
          </div>
          {NAV.length > 1 && NAV.map((n) => (
            <button
              key={n.view}
              type="button"
              onClick={() => setView(n.view)}
              aria-current={n.view === view ? "page" : undefined}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                n.view === view ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {n.label}
            </button>
          ))}
          {APP_MODE === "offers" && (
            <button
              type="button"
              onClick={() => { setEditing(null); setView("new"); }}
              aria-current={view === "new" ? "page" : undefined}
              className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors ${
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
        {view === "new" && (
          <NewOffer
            key={editing?.id || `blank-${formNonce}`}
            settings={settings}
            initialContactId={initialContactId}
            restore={editing}
            onReset={resetForm}
            onSettingsSaved={(s) => setSettings(s)}
            // Switching to another of the agent's offers remounts the form on
            // that offer (the key is the offer id) — same path as History →
            // Edit, so the outgoing form still flushes its draft on unmount.
            onOpenOffer={(o) => { setEditing(o); try { window.scrollTo({ top: 0 }); } catch { /* noop */ } }}
            onDeal={() => setView("deals")}
          />
        )}
        {view === "history" && (
          <OffersHistory onEdit={(o) => { setEditing(o); setView("new"); }}
            onDeal={() => setView("deals")} />
        )}
        {view === "deals" && (
          <DealsView settings={settings}
            onEdit={APP_MODE === "deals"
              ? (o) => window.open(offerEditorUrl(o.id), "_blank")
              : (o) => { setEditing(o); setView("new"); }} />
        )}
        {view === "outreach" && <AgentOutreach settings={settings} />}
        {view === "dispo" && <Dispositions />}
        {view === "dashboard" && <Dashboard settings={settings} onSettingsSaved={(s) => setSettings(s)} />}
        {view === "settings" && (
          <SettingsView settings={settings} onSaved={(s) => setSettings(s)} mode={APP_MODE} />
        )}
      </div>
    </div>
  );
}
