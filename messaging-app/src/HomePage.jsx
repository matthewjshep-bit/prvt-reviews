// HomePage.jsx — the consolidated daily operating screen. Four contact-driven
// sections stacked top-to-bottom, plus the existing template editor as one more
// view. Split-ready: every section also renders standalone via ?view=, so each
// can later become its own GHL Custom Menu Link with zero code changes.
//
//   ?view=all      (default) — all four sections, lazy-loaded on scroll
//   ?view=quotes | reviews | winback | offers — a single section, standalone
//   ?view=studio   — the existing Card Studio / Messaging editor, untouched
//
// Lazy-load: on boot only the first section fetches; the rest fetch when they
// scroll into view. Card previews render only when a row is selected.

import React, { useEffect, useMemo, useRef, useState } from "react";
import QuoteFollowUp from "./home/QuoteFollowUp.jsx";
import Reviews from "./home/Reviews.jsx";
import WinBack from "./home/WinBack.jsx";
import Offers from "./home/Offers.jsx";
import Contacts from "./home/Contacts.jsx";
import StudioFlow from "./studio/StudioFlow.jsx";

const SECTION_ORDER = ["quotes", "reviews", "winback", "offers"];
const SECTION_COMP = { quotes: QuoteFollowUp, reviews: Reviews, winback: WinBack, offers: Offers };
const NAV = [
  { view: "all", label: "Home" },
  { view: "quotes", label: "Quotes" },
  { view: "reviews", label: "Reviews" },
  { view: "winback", label: "Win-back" },
  { view: "offers", label: "Offers" },
  { view: "contacts", label: "Contacts" },
  { view: "studio", label: "Card Studio" },
];

function readView() {
  try {
    const v = new URLSearchParams(window.location.search).get("view") || "all";
    return NAV.some((n) => n.view === v) ? v : "all";
  } catch {
    return "all";
  }
}
function writeView(view) {
  try {
    const p = new URLSearchParams(window.location.search);
    if (view === "all") p.delete("view");
    else p.set("view", view);
    const qs = p.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  } catch { /* ignore */ }
}

// Activate a child once it scrolls near the viewport (lazy-load trigger).
function LazyMount({ eager, children }) {
  const ref = useRef(null);
  const [active, setActive] = useState(Boolean(eager));
  useEffect(() => {
    if (active || !ref.current) return;
    const el = ref.current;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) { setActive(true); io.disconnect(); }
      },
      { rootMargin: "200px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);
  return <div ref={ref}>{children(active)}</div>;
}

export default function HomePage() {
  const [view, setView] = useState(readView);

  // Keep in-app switching and the browser back/forward button in sync.
  useEffect(() => {
    const onPop = () => setView(readView());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  function go(v) { setView(v); writeView(v); window.scrollTo({ top: 0 }); }

  // Card Studio — the 3-step flow (Choose → Design → Send).
  if (view === "studio") {
    return (
      <div className="min-h-screen bg-gray-50 text-gray-900">
        <TopNav view={view} onSelect={go} />
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <StudioFlow />
        </div>
      </div>
    );
  }

  const single = SECTION_ORDER.includes(view);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <TopNav view={view} onSelect={go} />
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {view === "contacts" ? (
          <Contacts />
        ) : single ? (
          <SectionRenderer view={view} eager />
        ) : (
          <div className="space-y-6">
            {SECTION_ORDER.map((v, i) => (
              <LazyMount key={v} eager={i === 0}>
                {(active) => <SectionRenderer view={v} active={active} />}
              </LazyMount>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionRenderer({ view, active, eager }) {
  const Comp = SECTION_COMP[view];
  if (!Comp) return null;
  return <Comp active={eager ? true : active} />;
}

function TopNav({ view, onSelect }) {
  return (
    <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-1 overflow-x-auto px-4 py-2.5 sm:px-6">
        {NAV.map((n) => {
          const active = n.view === view || (view === "all" && n.view === "all");
          return (
            <button
              key={n.view}
              type="button"
              onClick={() => onSelect(n.view)}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                active ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {n.label}
            </button>
          );
        })}
      </div>
    </header>
  );
}
