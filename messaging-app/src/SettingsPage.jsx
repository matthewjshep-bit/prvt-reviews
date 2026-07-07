import React, { useState, useEffect, useMemo } from "react";
import { Settings, ExternalLink, CheckCircle2, AlertCircle } from "lucide-react";

// For local dev, this defaults to the broker's port. In production on Render,
// they are deployed together or you can inject it via env.
const API_BASE = "https://prvt-reviews-1.onrender.com";
const GREEN = "#16a34a";

function getLocationId() {
  try {
    return new URLSearchParams(window.location.search).get("location_id") || "";
  } catch {
    return "";
  }
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-xl border border-gray-200 bg-white ${className}`}>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const locationId = useMemo(getLocationId, []);

  const [loading, setLoading] = useState(true);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleConnectUrl, setGoogleConnectUrl] = useState("");
  const [googleLocationId, setGoogleLocationId] = useState(null);
  const [error, setError] = useState(null);

  const [fetchingLocations, setFetchingLocations] = useState(false);
  const [availableLocations, setAvailableLocations] = useState([]);
  const [savingLocation, setSavingLocation] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!locationId) {
        setError("Missing location_id in URL");
        setLoading(false);
        return;
      }
      try {
        const r = await fetch(
          `${API_BASE}/api/dashboard?location_id=${encodeURIComponent(
            locationId
          )}`
        );
        if (!r.ok) throw new Error("Failed to fetch settings");
        const data = await r.json();
        if (!alive) return;

        setGoogleConnected(data.googleConnected || false);
        setGoogleLocationId(data.googleLocationId || null);
        setGoogleConnectUrl(data.googleConnectUrl || "");
        setLoading(false);
      } catch (err) {
        if (alive) {
          setError(err.message);
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [locationId]);

  useEffect(() => {
    if (googleConnected && !googleLocationId && !loading) {
      setFetchingLocations(true);
      fetch(
        `${API_BASE}/api/google/locations?location_id=${encodeURIComponent(
          locationId
        )}`
      )
        .then((res) => res.json())
        .then((data) => {
          if (Array.isArray(data)) setAvailableLocations(data);
          else setError(data.error || "Failed to fetch locations");
        })
        .catch((err) => setError(err.message))
        .finally(() => setFetchingLocations(false));
    }
  }, [googleConnected, googleLocationId, loading, locationId]);

  const handleSaveLocation = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const val = formData.get("locationStr");
    if (!val) return;
    const [accountId, googleLocIdStr] = val.split("|");
    setSavingLocation(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/google/location?location_id=${encodeURIComponent(
          locationId
        )}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId, googleLocationId: googleLocIdStr }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to save location");
      }
      setGoogleLocationId(googleLocIdStr);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingLocation(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 px-6 py-8 text-gray-900">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-200">
            <Settings className="h-5 w-5 text-gray-700" />
          </div>
          <h1 className="text-2xl font-bold">Integrations & Settings</h1>
        </header>

        {error && (
          <div className="mb-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <strong>Error:</strong> {error}
          </div>
        )}

        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="flex-1">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <svg
                    className="h-5 w-5 text-gray-700"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                  </svg>
                  Google Business Profile
                </h2>
                <p className="mt-1 text-sm text-gray-500 max-w-lg">
                  Connect your Google Business Profile to pull in live reviews,
                  monitor your rating, and track performance over time directly
                  within the dashboard.
                </p>
              </div>

              <div className="shrink-0 flex items-center h-full mt-2 sm:mt-0">
                {loading ? (
                  <div className="h-10 w-32 animate-pulse rounded-lg bg-gray-200"></div>
                ) : googleConnected ? (
                  googleLocationId ? (
                    <div className="flex items-center gap-2 rounded-full border border-green-200 bg-green-50 px-4 py-2 text-sm font-semibold text-green-700">
                      <CheckCircle2 className="h-4 w-4" />
                      Connected
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 items-end">
                      <div className="flex items-center gap-1 text-sm font-semibold text-amber-600">
                        <AlertCircle className="h-4 w-4" />
                        Select Business Profile
                      </div>
                      {fetchingLocations ? (
                        <div className="text-sm text-gray-500">
                          Fetching your locations...
                        </div>
                      ) : availableLocations.length > 0 ? (
                        <form onSubmit={handleSaveLocation} className="flex gap-2">
                          <select
                            name="locationStr"
                            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            required
                          >
                            <option value="">-- Choose Profile --</option>
                            {availableLocations.map((loc) => (
                              <option
                                key={loc.locationId}
                                value={`${loc.accountId}|${loc.locationId}`}
                              >
                                {loc.title}
                              </option>
                            ))}
                          </select>
                          <button
                            disabled={savingLocation}
                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {savingLocation ? "Saving..." : "Save"}
                          </button>
                        </form>
                      ) : (
                        <div className="text-sm text-red-600">
                          No Google locations found for this account.
                        </div>
                      )}
                    </div>
                  )
                ) : (
                  <a
                    href={googleConnectUrl || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 shadow-sm"
                    style={{ backgroundColor: GREEN }}
                  >
                    Connect Google
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
