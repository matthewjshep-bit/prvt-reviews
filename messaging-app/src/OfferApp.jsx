// OfferApp.jsx — the offer generator shell. Four views:
//   New Offer — pick a contact, enter property numbers, get three offers,
//               generate the document, attach it to the contact record.
//   History   — every offer created for this location, grouped by agent.
//   Deals     — offers under signed contract, tracked through disposition.
//   Settings  — calculation defaults + company info printed on the document.

import React, { useEffect, useState } from "react";
import NewOffer from "./NewOffer.jsx";
import OffersHistory from "./OffersHistory.jsx";
import DealsView from "./DealsView.jsx";
import AgentOutreach from "./AgentOutreach.jsx";
import Dashboard from "./Dashboard.jsx";
import SettingsView from "./SettingsView.jsx";
import { getLocationId, getOffer, getSettings } from "./api.js";

// Which product this page is. One deploy serves all three: /agents (any depth)
// is the Agent Outreach app, /dashboard is the analytics Dashboard, everything
// else is the offer generator. The Netlify SPA redirect sends every path to
// this same bundle; VITE_APP_MODE still forces a mode for a dedicated-domain
// deploy.
const APP_MODE = (() => {
  try {
    if (import.meta.env.VITE_APP_MODE === "outreach") return "outreach";
    if (import.meta.env.VITE_APP_MODE === "dashboard") return "dashboard";
    if (/^\/dashboard(\/|$)/.test(window.location.pathname)) return "dashboard";
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
    : APP_MODE === "dashboard"
    ? [{ view: "dashboard", label: "Dashboard" }]
    : [
        { view: "new", label: "New Offer" },
        { view: "history", label: "History" },
        { view: "deals", label: "Deals" },
        { view: "settings", label: "Settings" },
      ];

function readParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name) || "";
  } catch {
    return "";
  }
}

export default function OfferApp() {
  const [view, setView] = useState(() => {
    const v = readParam("view");
    return NAV.some((n) => n.view === v) ? v : NAV[0].view;
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

  // Deep link from the GHL contact note: ?offer_id= reopens that offer in the
  // editor (same path as History → Edit) once it loads.
  useEffect(() => {
    if (APP_MODE === "outreach") return; // offers-only deep link
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <div className="mr-2 text-sm font-bold tracking-tight">
            {APP_MODE === "outreach" ? "Agent Outreach" : APP_MODE === "dashboard" ? "Dashboard" : "Offer Generator"}
          </div>
          {NAV.length > 1 && NAV.map((n) => (
            <button
              key={n.view}
              type="button"
              onClick={() => { if (n.view === "new") setEditing(null); setView(n.view); }}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                n.view === view ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {n.label}
            </button>
          ))}
        </div>
      </header>
      <div className={`mx-auto px-4 py-6 sm:px-6 ${view === "new" ? "max-w-7xl" : "max-w-5xl"}`}>
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
          />
        )}
        {view === "history" && (
          <OffersHistory onEdit={(o) => { setEditing(o); setView("new"); }}
            onDeal={() => setView("deals")} />
        )}
        {view === "deals" && (
          <DealsView settings={settings} onEdit={(o) => { setEditing(o); setView("new"); }} />
        )}
        {view === "outreach" && <AgentOutreach settings={settings} />}
        {view === "dashboard" && <Dashboard settings={settings} onSettingsSaved={(s) => setSettings(s)} />}
        {view === "settings" && (
          <SettingsView settings={settings} onSaved={(s) => setSettings(s)} mode={APP_MODE} />
        )}
      </div>
    </div>
  );
}
