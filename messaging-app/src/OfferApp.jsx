// OfferApp.jsx — the offer generator shell. Three views:
//   New Offer — pick a contact, enter property numbers, get three offers,
//               generate the document, attach it to the contact record.
//   History   — every offer created for this location.
//   Settings  — calculation defaults + company info printed on the document.

import React, { useEffect, useState } from "react";
import NewOffer from "./NewOffer.jsx";
import OffersHistory from "./OffersHistory.jsx";
import SettingsView from "./SettingsView.jsx";
import { getLocationId, getSettings } from "./api.js";

const NAV = [
  { view: "new", label: "New Offer" },
  { view: "history", label: "History" },
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
    return NAV.some((n) => n.view === v) ? v : "new";
  });
  const [initialContactId] = useState(() => readParam("contact_id"));
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) => setSettingsError(e.message));
  }, []);

  if (!getLocationId()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6 text-center text-gray-600">
        <div>
          <div className="text-lg font-semibold text-gray-900">Missing location</div>
          <p className="mt-1 text-sm">Open this page from its GHL menu link so ?location_id= is set.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <div className="mr-2 text-sm font-bold tracking-tight">Offer Generator</div>
          {NAV.map((n) => (
            <button
              key={n.view}
              type="button"
              onClick={() => setView(n.view)}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                n.view === view ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {n.label}
            </button>
          ))}
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {settingsError && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            Couldn't load saved settings ({settingsError}) — using defaults.
          </div>
        )}
        {view === "new" && <NewOffer settings={settings} initialContactId={initialContactId} />}
        {view === "history" && <OffersHistory />}
        {view === "settings" && (
          <SettingsView settings={settings} onSaved={(s) => setSettings(s)} />
        )}
      </div>
    </div>
  );
}
