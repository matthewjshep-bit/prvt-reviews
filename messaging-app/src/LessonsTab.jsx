// LessonsTab.jsx — the Lessons tab of /reports: what came back (outcomes)
// and what the deals that died have to teach. Moved out of the bottom of the
// Activity charts so each can be found without scrolling past the other.

import React, { useState } from "react";
import { FilterChips } from "./ui.jsx";
import FunnelView from "./FunnelView.jsx";
import LessonsView from "./LessonsView.jsx";

const RANGES = [{ key: 7, label: "Last 7 days" }, { key: 30, label: "Last 30 days" }, { key: 90, label: "Last 90 days" }];

export default function LessonsTab({ onSettingsSaved }) {
  const [days, setDays] = useState(30);
  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-bold">Outcomes</h2>
          <FilterChips value={days} onChange={setDays} label="Window" options={RANGES} />
        </div>
        <FunnelView days={days} />
      </div>
      {/* Read-only until a person presses Apply on a recommendation. */}
      <div>
        <h2 className="mb-2 text-sm font-bold">Lessons from deals that fell through</h2>
        <LessonsView onSettingsSaved={onSettingsSaved} />
      </div>
    </div>
  );
}
