// AutopilotView.jsx — the Controls tab of /autopilot: the dial and every
// self-driving switch, on their own page. Until 2026-09-13 this card sat on
// both Flow and Pipeline; now Today shows a one-line status that links here.

import React, { useEffect, useState } from "react";
import { getDashboardPipeline } from "./api.js";
import { ErrorBar, SkeletonRows } from "./ui.jsx";
import AutopilotCard from "./AutopilotCard.jsx";

export default function AutopilotView() {
  const [autopilot, setAutopilot] = useState(null);
  const [conversationEnabled, setConversationEnabled] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let live = true;
    getDashboardPipeline()
      .then((r) => { if (!live) return; setAutopilot(r.autopilot); setConversationEnabled(r.conversationEnabled !== false); setError(""); })
      .catch((e) => { if (live) setError(e.message || "Couldn't load the autopilot."); });
    return () => { live = false; };
  }, [refreshKey]);

  if (!autopilot && !error) return <SkeletonRows rows={5} />;
  return (
    <div className="space-y-4">
      {error && <ErrorBar>{error}</ErrorBar>}
      {!conversationEnabled && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          The Conversation AI is switched off, so nothing is moving on its own.
        </div>
      )}
      <AutopilotCard autopilot={autopilot} onDone={() => setRefreshKey((k) => k + 1)} />
    </div>
  );
}
