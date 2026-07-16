// journeys/Journeys.jsx — the Journeys view: map multi-step card+text
// lifecycles. v1 is a MAPPING tool: waits are labels and each step is fired
// manually — nothing sends on a timer. List screen here; the mapper lives in
// JourneyEditor.jsx.

import React, { useEffect, useState } from "react";
import { Map as MapIcon, Trash2 } from "lucide-react";
import * as api from "../home/api.js";
import { Card, EmptyState, ErrorBanner, SendButton } from "../home/ui.jsx";
import JourneyEditor from "./JourneyEditor.jsx";

export default function Journeys() {
  const [journeys, setJourneys] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null); // journey being edited
  const [creating, setCreating] = useState(false);

  const load = () =>
    api.listJourneys().then(setJourneys).catch((e) => setError(e.message || "Couldn’t load journeys"));
  useEffect(() => { load(); }, []);

  async function createNew() {
    setCreating(true);
    try {
      const jny = await api.createJourney({
        name: "New journey",
        active: true,
        steps: [{ templateId: "", message: "", waitDays: 0 }],
      });
      setOpenId(jny.id);
      load();
    } catch (e) {
      setError(e.message || "Couldn’t create");
    } finally {
      setCreating(false);
    }
  }

  async function remove(id, name) {
    if (!window.confirm(`Delete "${name}"? Enrollment history goes with it.`)) return;
    await api.deleteJourney(id);
    load();
  }

  if (openId) {
    return <JourneyEditor journeyId={openId} onBack={() => { setOpenId(null); load(); }} />;
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Journeys</h2>
          <p className="mt-0.5 text-sm text-gray-500">
            Map a lifecycle of cards + texts — offer → one-pager → follow-up → review. You fire each step; nothing sends on a timer.
          </p>
        </div>
        <div className="w-40 shrink-0">
          <SendButton onClick={createNew} busy={creating}>＋ New journey</SendButton>
        </div>
      </div>

      {error ? (
        <ErrorBanner onRetry={() => { setError(null); load(); }}>{error}</ErrorBanner>
      ) : journeys === null ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-100" />)}
        </div>
      ) : journeys.length === 0 ? (
        <EmptyState>No journeys yet — create one and string your cards together.</EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {journeys.map((j) => (
            <div key={j.id} className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4">
              <button type="button" onClick={() => setOpenId(j.id)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-2">
                  <MapIcon className="h-4 w-4 shrink-0 text-gray-400" />
                  <span className="truncate text-sm font-semibold text-gray-900">{j.name}</span>
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  {(j.steps || []).length} step{(j.steps || []).length === 1 ? "" : "s"} · {j.activeCount || 0} active contact{(j.activeCount || 0) === 1 ? "" : "s"}
                </div>
              </button>
              <button
                type="button"
                onClick={() => remove(j.id, j.name)}
                className="shrink-0 rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500"
                title="Delete journey"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
