import React, { useState, useEffect, useMemo } from "react";
import {
  Star,
  Users,
  MessageSquare,
  MousePointerClick,
  Send,
  MapPin,
  Copy,
  RefreshCw,
  BarChart3,
  TrendingUp,
} from "lucide-react";

const API_BASE = "https://prvt-reviews-1.onrender.com"; // same origin as the deployed iframe app
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

function StatTile({ title, value, Icon }) {
  return (
    <Card className="flex flex-col p-4">
      <div className="mb-2 flex items-center justify-between text-gray-500">
        <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
        <Icon className="h-4 w-4" />
      </div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
    </Card>
  );
}

function StarRating({ rating }) {
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    const fill = rating >= i ? 1 : rating >= i - 0.5 ? 0.5 : 0;
    stars.push(
      <div key={i} className="relative h-5 w-5">
        <Star className="absolute left-0 top-0 h-5 w-5 text-gray-300" fill="currentColor" />
        {fill > 0 && (
          <div
            className="absolute left-0 top-0 overflow-hidden"
            style={{ width: `${fill * 100}%` }}
          >
            <Star className="h-5 w-5 text-yellow-400" fill="currentColor" />
          </div>
        )}
      </div>
    );
  }
  return <div className="flex gap-1">{stars}</div>;
}

export default function DashboardPage() {
  const locationId = useMemo(getLocationId, []);

  const [businessName, setBusinessName] = useState("");
  const [data, setData] = useState({
    rating: 0,
    reviewCount: 0,
    last30: { newReviews: 0, updatedReviews: 0, linkClicks: 0, requestsSent: 0, contactsAdded: 0 },
    history: [],
    reviewLink: "",
    mapsUrl: "",
  });

  const [projectionN, setProjectionN] = useState(0);
  const [chartPeriod, setChartPeriod] = useState("30d"); // 7d, 30d, all
  const [debugErrors, setDebugErrors] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/dashboard?location_id=${encodeURIComponent(locationId)}`);
        if (!r.ok) throw new Error();
        const c = await r.json();
        if (!alive) return;
        if (c.businessName) setBusinessName(c.businessName);
        if (c._debugError || c._debugContactsError) {
          setDebugErrors([c._debugError, c._debugContactsError].filter(Boolean));
        }
        setData({
          rating: c.rating || 0,
          reviewCount: c.reviewCount || 0,
          last30: c.last30 || { newReviews: 0, updatedReviews: 0, linkClicks: 0, requestsSent: 0, contactsAdded: 0 },
          history: c.history || [],
          reviewLink: c.reviewLink || "",
          mapsUrl: c.mapsUrl || "",
        });
      } catch {
        // fallback to empty state
      }
    })();
    return () => {
      alive = false;
    };
  }, [locationId]);

  function showToast(msg) {
    setToast(msg);
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 2600);
  }

  function copyReviewLink() {
    if (!data.reviewLink) {
      showToast("No review link configured");
      return;
    }
    navigator.clipboard.writeText(data.reviewLink);
    showToast("Review link copied!");
  }

  // --- Math Logic ---
  const currentTotalStars = data.rating * data.reviewCount;
  
  const projectedRating = (currentTotalStars + 5 * projectionN) / (data.reviewCount + projectionN) || 0;
  const displayProjected = Math.min(5, Math.round(projectedRating * 10) / 10).toFixed(1);

  function reviewsNeeded(T) {
    if (5 - T <= 0) return Infinity;
    return Math.max(0, Math.ceil((T * data.reviewCount - currentTotalStars) / (5 - T)));
  }

  const milestones = [4.0, 4.5, 4.8, 5.0].map((t) => {
    const needed = reviewsNeeded(t);
    const reached = needed === 0;
    const impossible = needed === Infinity;
    
    // progress bar logic (just visual relative to next milestone or something simple)
    // We'll show % to target. 
    // current rating / target rating
    const percent = Math.min(100, (data.rating / t) * 100);

    return { target: t, needed, reached, impossible, percent };
  });

  // --- Chart Logic ---
  const filteredHistory = useMemo(() => {
    if (chartPeriod === "all" || !data.history.length) return data.history;
    const days = chartPeriod === "7d" ? 7 : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return data.history.filter(h => new Date(h.date) >= cutoff);
  }, [data.history, chartPeriod]);

  const maxChartValue = Math.max(1, ...filteredHistory.map(d => d.count));

  return (
    <div className="min-h-screen bg-gray-50 px-6 py-8 text-gray-900">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <div className="mt-1 flex items-center gap-2">
              <input 
                type="text" 
                value={businessName} 
                onChange={e => setBusinessName(e.target.value)}
                placeholder="Business Name"
                className="bg-transparent text-sm font-semibold text-gray-500 outline-none hover:bg-gray-100 focus:bg-white focus:ring-2 focus:ring-green-100 rounded px-1 -ml-1 transition-colors"
              />
            </div>
          </div>
        </header>

        {debugErrors && debugErrors.length > 0 && (
          <div className="mb-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <strong>API Errors Detected:</strong>
            <ul className="mt-2 list-disc pl-5">
              {debugErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          {/* Left Column */}
          <div className="space-y-8 lg:col-span-2">
            
            <section>
              <h2 className="mb-4 text-lg font-bold">Last 30 Days Performance</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
                <StatTile title="New Reviews" value={data.last30.newReviews} Icon={Star} />
                <StatTile title="Updated" value={data.last30.updatedReviews} Icon={RefreshCw} />
                <StatTile title="Link Clicks" value={data.last30.linkClicks} Icon={MousePointerClick} />
                <StatTile title="Sent" value={data.last30.requestsSent} Icon={Send} />
                <StatTile title="Contacts" value={data.last30.contactsAdded} Icon={Users} />
              </div>
            </section>

            <section>
              <Card className="p-6">
                <div className="mb-6 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 text-gray-400" />
                    <h2 className="text-base font-bold">Review History</h2>
                  </div>
                  <div className="flex overflow-hidden rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                    {["7d", "30d", "all"].map((p) => (
                      <button
                        key={p}
                        onClick={() => setChartPeriod(p)}
                        className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                          chartPeriod === p ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="relative h-48 w-full border-b border-l border-gray-200 pt-4 pr-2">
                  {filteredHistory.length === 0 ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm font-medium text-gray-400">
                      No data for this period
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex items-end justify-around pl-2 pt-2 pb-0">
                      {filteredHistory.map((d, i) => {
                        const height = (d.count / maxChartValue) * 100;
                        return (
                          <div key={i} className="group relative flex h-full w-full flex-col justify-end px-0.5 sm:px-1">
                            <div 
                              className="w-full rounded-t-sm transition-all duration-300 hover:opacity-80"
                              style={{ height: `${height}%`, backgroundColor: GREEN }}
                            />
                            {/* Tooltip */}
                            <div className="absolute -top-8 left-1/2 hidden -translate-x-1/2 rounded bg-gray-800 px-2 py-1 text-xs text-white group-hover:block">
                              {d.count}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </Card>
            </section>

          </div>

          {/* Right Column */}
          <div className="space-y-6">
            
            <Card className="p-6">
              <div className="mb-2 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                  <svg className="h-4 w-4" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                    <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                  </svg>
                </div>
                <h2 className="text-lg font-bold">Google Reviews</h2>
              </div>
              
              <div className="mt-4 flex items-end gap-3">
                <span className="text-4xl font-extrabold text-gray-900">{data.rating.toFixed(1)}</span>
                <div className="pb-1">
                  <StarRating rating={data.rating} />
                  <div className="mt-1 text-sm font-medium text-gray-500">
                    {data.reviewCount.toLocaleString()} Google reviews
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <div className="mb-4 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-gray-400" />
                <h3 className="text-base font-bold">Rating Projection</h3>
              </div>
              
              <div className="mb-4 rounded-lg border border-gray-100 bg-gray-50 p-4 text-center">
                <div className="text-sm font-semibold text-gray-500">Projected Rating</div>
                <div className="mt-1 text-3xl font-bold text-gray-900">{displayProjected}</div>
              </div>

              <div className="space-y-4">
                <div>
                  <div className="mb-2 flex justify-between text-sm font-semibold">
                    <span className="text-gray-700">Add 5-star reviews</span>
                    <span className="text-green-600">+{projectionN}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={Math.max(100, projectionN * 2)}
                    value={projectionN}
                    onChange={(e) => setProjectionN(parseInt(e.target.value, 10))}
                    className="w-full accent-green-600"
                  />
                  <div className="mt-2 text-center text-xs text-gray-500">
                    {projectionN === 0 ? "Move slider to see projection" : `If you get ${projectionN} more 5-star reviews`}
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <h3 className="mb-4 text-base font-bold">Milestones</h3>
              <div className="space-y-4">
                {milestones.map((m) => (
                  <div key={m.target}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-bold text-gray-900">{m.target.toFixed(1)} Stars</span>
                      <span className="font-semibold text-gray-500">
                        {m.reached ? "Reached" : m.impossible ? "—" : `${m.needed.toLocaleString()} needed`}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                      <div 
                        className="h-full rounded-full transition-all"
                        style={{ 
                          width: `${m.percent}%`,
                          backgroundColor: m.reached ? GREEN : m.impossible ? "#d1d5db" : "#3b82f6" 
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <div className="flex gap-3">
              <button
                onClick={() => data.mapsUrl ? window.open(data.mapsUrl, "_blank") : showToast("No Maps URL configured")}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <MapPin className="h-4 w-4" />
                View Map
              </button>
              <button
                onClick={copyReviewLink}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: GREEN }}
              >
                <Copy className="h-4 w-4" />
                Copy Link
              </button>
            </div>

          </div>
        </div>

        {/* toast */}
        {toast && (
          <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
