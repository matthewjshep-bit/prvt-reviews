// StudioFlow.jsx — the redesigned Card Studio: a simple 3-step flow.
//
//   1 Choose  — pick the card you're working on (organized by section + Drafts)
//   2 Design  — the editor (slim toolbar; drag fields onto the canvas)
//   3 Send    — ad-hoc sender (people / phone / tag); queue sends stay on Home
//
// CardStudio stays mounted across steps so editor state survives navigation.
// Saving a card started from a section's preset auto-assigns it there.

import React, { useEffect, useRef, useState } from "react";
import CardStudio from "./CardStudio.jsx";
import ChooseStep from "./ChooseStep.jsx";
import SendStep from "./SendStep.jsx";
import { API_BASE, getLocationId } from "./api.js";
import { getHomeConfig, saveSectionConfig } from "../home/api.js";

const SECTION_LABELS = { quotes: "Quote follow-up", reviews: "Reviews", winback: "Win-back", offers: "Offers" };
const DEFAULT_MESSAGE =
  "Hey {{contact.first_name}}, here's something from {{loc.business_name}} — reply here if you have any questions!";

export default function StudioFlow() {
  const locationId = getLocationId();
  const controller = useRef({});
  const [step, setStep] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("template") ? "design" : "choose"; }
    catch { return "choose"; }
  });
  const [studioState, setStudioState] = useState({ templates: [], currentId: null, dirty: false });
  const [liveTemplate, setLiveTemplate] = useState(null);
  const [homeConfig, setHomeConfig] = useState(null); // { assignments, sections }
  const [config, setConfig] = useState({});           // businessName, reviewLink
  const [pendingAssign, setPendingAssign] = useState(null);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [toast, setToast] = useState(null);

  const showToast = (m) => {
    setToast(m);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => setToast(null), 2600);
  };

  const refreshHomeConfig = () => getHomeConfig().then(setHomeConfig).catch(() => {});
  useEffect(() => { refreshHomeConfig(); }, []);
  useEffect(() => {
    fetch(`${API_BASE}/api/config?location_id=${encodeURIComponent(locationId)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then(setConfig)
      .catch(() => {});
  }, [locationId]);

  // Prefill the send message: the assigned section's message when this card is
  // assigned; otherwise keep whatever's there.
  const assignments = homeConfig?.assignments || {};
  const assignedSection = Object.keys(assignments).find((k) => assignments[k] === studioState.currentId);
  useEffect(() => {
    if (assignedSection && homeConfig?.sections?.[assignedSection]?.message) {
      setMessage(homeConfig.sections[assignedSection].message);
    }
  }, [assignedSection, studioState.currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-assign after saving a card started from a section preset.
  async function onSaved(tpl) {
    if (!pendingAssign) return;
    const existing = assignments[pendingAssign];
    if (existing && existing !== tpl.id) {
      if (!window.confirm(`${SECTION_LABELS[pendingAssign]} already sends another card. Replace it with "${tpl.name}"?`)) {
        setPendingAssign(null);
        return;
      }
    }
    try {
      await saveSectionConfig(pendingAssign, { templateId: tpl.id });
      showToast(`"${tpl.name}" now sends for ${SECTION_LABELS[pendingAssign]}`);
      refreshHomeConfig();
    } catch (e) {
      showToast("Couldn’t assign: " + (e.message || "error"));
    }
    setPendingAssign(null);
  }

  function goChoose() { refreshHomeConfig(); setStep("choose"); }

  const steps = [
    { key: "choose", n: 1, label: "Choose", enabled: true },
    { key: "design", n: 2, label: "Design", enabled: Boolean(liveTemplate) },
    { key: "send", n: 3, label: "Send", enabled: Boolean(studioState.currentId) },
  ];

  return (
    <div>
      {/* stepper */}
      <div className="mb-6 flex items-center justify-center gap-2">
        {steps.map((s, i) => (
          <React.Fragment key={s.key}>
            {i > 0 ? <div className="h-px w-8 bg-gray-300" /> : null}
            <button
              type="button"
              disabled={!s.enabled}
              onClick={() => (s.key === "choose" ? goChoose() : setStep(s.key))}
              className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors disabled:opacity-40 ${
                step === s.key ? "bg-gray-900 text-white" : "bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
              }`}
            >
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${step === s.key ? "bg-white/20" : "bg-gray-100 text-gray-500"}`}>
                {s.n}
              </span>
              {s.label}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* step 1 */}
      {step === "choose" ? (
        <ChooseStep
          templates={studioState.templates}
          assignments={assignments}
          onEdit={(id) => { controller.current?.loadTemplate?.(id); setStep("design"); }}
          onNewFromPreset={(sectionKey, starter) => {
            controller.current?.newFromStarter?.(starter.build);
            if (starter.message) setMessage(starter.message);
            setPendingAssign(sectionKey);
            setStep("design");
          }}
          onNewFromStarter={(starter) => {
            controller.current?.newFromStarter?.(starter.build);
            if (starter.message) setMessage(starter.message);
            setPendingAssign(null);
            setStep("design");
          }}
        />
      ) : null}

      {/* step 2 — CardStudio stays mounted so editor state survives */}
      <div className={step === "design" ? "" : "hidden"}>
        {pendingAssign ? (
          <div className="mb-3 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-800">
            Designing the <span className="font-semibold">{SECTION_LABELS[pendingAssign]}</span> card — it's assigned automatically when you save.
          </div>
        ) : null}
        <CardStudio
          flowMode
          controller={controller}
          onTemplateChange={setLiveTemplate}
          onStudioState={setStudioState}
          onSaved={onSaved}
        />
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            disabled={!studioState.currentId}
            onClick={() => setStep("send")}
            className="rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
            title={studioState.currentId ? "" : "Save the card first"}
          >
            Next: Send →
          </button>
        </div>
      </div>

      {/* step 3 */}
      {step === "send" ? (
        <SendStep
          template={liveTemplate}
          templateId={studioState.currentId}
          dirty={studioState.dirty}
          onRequestSave={() => controller.current?.save?.()}
          message={message}
          onMessageChange={setMessage}
          businessName={config.businessName}
          reviewLink={config.reviewLink}
        />
      ) : null}

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
