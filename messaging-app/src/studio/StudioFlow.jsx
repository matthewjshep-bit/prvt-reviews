// StudioFlow.jsx — the redesigned Card Studio: a simple 3-step flow.
//
//   1 Choose  — pick the card you're working on (organized by section + Drafts)
//   2 Design  — the editor (slim toolbar; drag fields onto the canvas)
//   3 Send    — ad-hoc sender (people / phone / tag); queue sends stay on Home
//
// CardStudio stays mounted across steps so editor state survives navigation.
// Saving a card started from a section's preset auto-assigns it there.

import React, { useEffect, useMemo, useRef, useState } from "react";
import CardStudio from "./CardStudio.jsx";
import ChooseStep from "./ChooseStep.jsx";
import SendStep from "./SendStep.jsx";
import PreviewContactPanel from "./PreviewContactPanel.jsx";
import BrandEditor from "./BrandEditor.jsx";
import { applyBrand } from "./brand.js";
import { API_BASE, getLocationId, testProvider } from "./api.js";
import { getHomeConfig, saveSectionConfig } from "../home/api.js";
import { extractTemplateBindings } from "@shared/bindings.js";

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

  // Brand kit — themes gallery previews + new cards. Stored in config CVs.
  const [brandOpen, setBrandOpen] = useState(false);
  const [brandSaving, setBrandSaving] = useState(false);
  const brand = useMemo(
    () => ({
      background: config.brandBg || "", accent: config.brandAccent || "",
      text: config.brandText || "", font: config.brandFont || "",
      industry: config.brandIndustry || "",
    }),
    [config.brandBg, config.brandAccent, config.brandText, config.brandFont, config.brandIndustry]
  );
  async function saveBrand(next) {
    setBrandSaving(true);
    try {
      const r = await fetch(`${API_BASE}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: locationId,
          brandBg: next.background, brandAccent: next.accent, brandText: next.text,
          brandFont: next.font, brandIndustry: next.industry || "",
        }),
      });
      if (!r.ok) throw new Error("save failed");
      setConfig((c) => ({
        ...c, brandBg: next.background, brandAccent: next.accent, brandText: next.text,
        brandFont: next.font, brandIndustry: next.industry || "",
      }));
      setBrandOpen(false);
      showToast("Brand saved — gallery and new cards use it now");
    } catch (e) {
      showToast("Couldn’t save the brand: " + (e.message || "error"));
    } finally {
      setBrandSaving(false);
    }
  }
  // New cards come out already themed.
  const brandedBuild = (build) => (args) => applyBrand(build(args), brand);

  // "Preview as" — a real contact whose fields drive the canvas AND a real
  // server render (actual imagery + values) replacing the editable canvas.
  const [previewContact, setPreviewContact] = useState(null);
  const [contactRenderUrl, setContactRenderUrl] = useState(null);
  const [contactRendering, setContactRendering] = useState(false);
  const [renderTick, setRenderTick] = useState(0); // manual "refresh render"
  const renderUrlRef = useRef(null);
  useEffect(() => {
    if (!(previewContact && liveTemplate?.layers?.length)) {
      setContactRenderUrl(null);
      return;
    }
    let cancelled = false;
    setContactRendering(true);
    (async () => {
      try {
        const merged = { ...liveTemplate, sampleData: { ...liveTemplate.sampleData, ...(previewContact.fields || {}) } };
        const r = await fetch(`${API_BASE}/api/render/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location_id: locationId, template: merged, sampleData: merged.sampleData }),
        });
        if (!r.ok) throw new Error("render failed");
        const blob = await r.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (renderUrlRef.current) URL.revokeObjectURL(renderUrlRef.current);
        renderUrlRef.current = url;
        setContactRenderUrl(url);
      } catch {
        if (!cancelled) { setContactRenderUrl(null); showToast("Couldn’t render for that contact"); }
      } finally {
        if (!cancelled) setContactRendering(false);
      }
    })();
    return () => { cancelled = true; };
    // Re-render on contact change, template save/switch, or manual refresh
    // (not every keystroke — the editable canvas covers live edits).
  }, [previewContact, liveTemplate?.id, liveTemplate?.version, renderTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const referenced = useMemo(
    () => new Set(liveTemplate ? extractTemplateBindings(liveTemplate) : []),
    [liveTemplate]
  );

  // Live imagery on the EDITABLE canvas: whenever a card with data sources is
  // opened or the preview contact changes, run each provider's test with the
  // current (sample or contact) inputs and swap the bound layers' preview
  // image for the real one — so the satellite/parcel/street image on the
  // canvas is the actual map, not a stock thumbnail.
  useEffect(() => {
    const tpl = liveTemplate;
    if (!tpl?.dataSources?.length) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const sampleData = { ...(tpl.sampleData || {}), ...(previewContact?.fields || {}) };
      for (const ds of tpl.dataSources) {
        try {
          const r = await testProvider(ds.provider, {
            inputs: ds.inputs,
            options: ds.options,
            connectionId: ds.connectionId || undefined,
            sampleData,
            targetPx: { width: 800, height: 800 },
            templateId: studioState.currentId || undefined,
            sourceId: ds.id,
          });
          if (!cancelled && r?.ok && r.imageUrl) {
            controller.current?.applySourceThumbnail?.(ds.id, r.imageUrl);
          }
        } catch { /* empty address / provider miss → keep the current preview */ }
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
    // Re-run when a different card opens or the preview contact changes.
  }, [studioState.currentId, previewContact]); // eslint-disable-line react-hooks/exhaustive-deps

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
          brand={brand}
          onOpenBrand={() => setBrandOpen(true)}
          onEdit={(id) => { controller.current?.loadTemplate?.(id); setStep("design"); }}
          onNewFromPreset={(sectionKey, starter) => {
            controller.current?.newFromStarter?.(brandedBuild(starter.build));
            if (starter.message) setMessage(starter.message);
            setPendingAssign(sectionKey);
            setStep("design");
          }}
          onNewFromStarter={(starter) => {
            controller.current?.newFromStarter?.(brandedBuild(starter.build));
            if (starter.message) setMessage(starter.message);
            setPendingAssign(null);
            setStep("design");
          }}
        />
      ) : null}

      <BrandEditor open={brandOpen} onClose={() => setBrandOpen(false)} brand={brand} onSave={saveBrand} saving={brandSaving} />

      {/* step 2 — CardStudio stays mounted so editor state survives */}
      <div className={step === "design" ? "" : "hidden"}>
        {pendingAssign ? (
          <div className="mb-3 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-800">
            Designing the <span className="font-semibold">{SECTION_LABELS[pendingAssign]}</span> card — it's assigned automatically when you save.
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[290px_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <PreviewContactPanel
              template={liveTemplate}
              referenced={referenced}
              previewContact={previewContact}
              onSelectContact={setPreviewContact}
              renderUrl={previewContact ? contactRenderUrl : null}
              renderLoading={contactRendering}
              onRefreshRender={() => setRenderTick((t) => t + 1)}
              onAddField={(token) => controller.current?.addField?.(token)}
              onEditSample={(token, v) =>
                controller.current?.patchTemplate?.({ sampleData: { ...(liveTemplate?.sampleData || {}), [token]: v } })
              }
              onCreatedField={() => controller.current?.refreshCustomFields?.()}
              showToast={showToast}
            />
          </div>
          <div className="min-w-0">
            {/* Canvas stays EDITABLE with the contact's real values merged in
                (previewOverride); the true server render lives in the rail. */}
            <CardStudio
              flowMode
              controller={controller}
              onTemplateChange={setLiveTemplate}
              onStudioState={setStudioState}
              onSaved={onSaved}
              previewOverride={previewContact?.fields}
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
