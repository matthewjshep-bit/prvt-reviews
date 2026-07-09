import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Sparkles,
  MessageSquare,
  TrendingUp,
  CheckCircle2,
  Image as ImageIcon,
  Clock,
  Bell,
  CalendarDays,
} from "lucide-react";

/*
  Messaging page — renders INSIDE the GHL iframe (the GHL sidebar is the shell
  around this; this component is just the content area).

  It is a control panel, not a sender. It reads/writes config to GHL via YOUR
  backend (never call GHL directly from the browser — the OAuth token must stay
  server-side). The backend contract this page expects:

    GET  /api/config?location_id=...     -> { ownerName, businessName, logoUrl,
                                              personalizedImage, smartEnabled,
                                              followUps, mode, customTemplate }
    POST /api/config        body: { location_id, ...sameFields }   (writes GHL custom values)
    POST /api/send-test     body: { location_id, ownerName, businessName, mode, customTemplate }
    POST /api/upload-logo   multipart file -> { url }   (stores image, returns public URL)

  The "logoUrl" written here is the same value the card service reads as ?bg=,
  closing the loop: this page saves it -> workflow URL references it -> card
  service renders the personalized image.

  Standalone fallback: if no backend is reachable (e.g. previewing this file on
  its own), it keeps sensible defaults so the UI still renders.
*/

const API_BASE = "https://prvt-reviews-1.onrender.com"; // same origin as the deployed iframe app
const BLUE = "#4c6ef5"; // outgoing SMS bubble
const GREEN = "#16a34a";

function getLocationId() {
  try {
    return new URLSearchParams(window.location.search).get("location_id") || "";
  } catch {
    return "";
  }
}

/* ---------- small UI primitives ---------- */

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
      style={{ backgroundColor: checked ? GREEN : "#d1d5db" }}
    >
      <span
        className="inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? "translateX(22px)" : "translateX(2px)" }}
      />
    </button>
  );
}

function Phone({ children }) {
  return (
    <div className="mx-auto w-[300px] max-w-full">
      <div className="relative rounded-[44px] border-[10px] border-black bg-white shadow-xl">
        <div className="absolute left-1/2 top-0 h-6 w-32 -translate-x-1/2 rounded-b-2xl bg-black" />
        <div className="flex items-center justify-between px-7 pt-3 text-xs font-medium text-gray-800">
          <span>9:41</span>
          <span className="h-3 w-6 rounded-sm border border-gray-500" />
        </div>
        <div className="min-h-[440px] px-4 pb-8 pt-4">{children}</div>
      </div>
    </div>
  );
}

/* The personalized card — visually mirrors what the card microservice renders
   server-side (dark brand background + white name pill). In production you can
   either keep this HTML mock for the preview, or point an <img> at the card
   service: `${CARD_SVC}/card?name=${name}&bg=${logoUrl}`. */
function PersonalizedCard({ businessName, name, logoUrl }) {
  return (
    <div
      className="relative mb-2 flex h-36 flex-col items-center justify-center gap-3 overflow-hidden rounded-xl"
      style={{ backgroundColor: "#0b0b0c" }}
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-90"
        />
      ) : null}
      <div className="relative z-10 px-2 text-center text-sm font-extrabold uppercase tracking-widest text-white">
        {businessName || "Your Business"}
      </div>
      <div className="relative z-10 rounded-full bg-white px-4 py-1 text-base font-extrabold text-gray-900">
        {name}!
      </div>
    </div>
  );
}

function Bubble({ children, side = "out", time }) {
  const out = side === "out";
  return (
    <div className={`mb-1 flex ${out ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[78%]">
        <div
          className="rounded-2xl px-3 py-2 text-[13px] leading-snug"
          style={
            out
              ? { backgroundColor: BLUE, color: "white" }
              : { backgroundColor: "#e5e7eb", color: "#111827" }
          }
        >
          {children}
        </div>
        {time ? (
          <div className={`mt-0.5 text-[10px] text-gray-400 ${out ? "text-right" : "text-left"}`}>
            {time}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-gray-900">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
      />
    </label>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-xl border border-gray-200 bg-white ${className}`}>{children}</div>
  );
}

/* ---------- main page ---------- */

export default function MessagingPage() {
  const locationId = useMemo(getLocationId, []);
  const fileRef = useRef(null);

  const [tab, setTab] = useState("smart"); // "smart" | "custom"
  const [ownerName, setOwnerName] = useState("Matt");
  const [businessName, setBusinessName] = useState("PRVT MKT");
  const [logoUrl, setLogoUrl] = useState(null);
  const [personalizedImage, setPersonalizedImage] = useState(true);
  const [smartEnabled, setSmartEnabled] = useState(true);
  const [followUps, setFollowUps] = useState(true);
  const [customTemplate, setCustomTemplate] = useState(
    "Hey {{first_name}}, we hope you enjoyed your experience with {{business_name}}! Would you mind taking a moment to leave a review? Here's the link: [Review Link]"
  );

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [toast, setToast] = useState(null);

  const [previewName, setPreviewName] = useState("Jessica");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/config?location_id=${encodeURIComponent(locationId)}`);
        if (!r.ok) throw new Error();
        const c = await r.json();
        if (!alive) return;
        if (c.ownerName != null) setOwnerName(c.ownerName);
        if (c.businessName != null) setBusinessName(c.businessName);
        if (c.logoUrl != null) setLogoUrl(c.logoUrl);
        if (c.personalizedImage != null) setPersonalizedImage(!!c.personalizedImage);
        if (c.smartEnabled != null) setSmartEnabled(!!c.smartEnabled);
        if (c.followUps != null) setFollowUps(!!c.followUps);
        if (c.mode) setTab(c.mode);
        if (c.customTemplate) setCustomTemplate(c.customTemplate);
      } catch {
        /* standalone preview — keep defaults */
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

  function edit(setter) {
    return (v) => {
      setter(v);
      setDirty(true);
    };
  }

  async function saveConfig() {
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: locationId,
          ownerName,
          businessName,
          logoUrl,
          personalizedImage,
          smartEnabled,
          followUps,
          mode: tab,
          customTemplate,
        }),
      });
      if (!r.ok) throw new Error();
      setDirty(false);
      showToast("Changes saved");
    } catch {
      showToast("Couldn’t save — check the connection");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (!testPhone.trim()) {
      showToast("Enter a phone number to send the test to");
      return;
    }
    setSendingTest(true);
    try {
      const r = await fetch(`${API_BASE}/api/send-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: locationId,
          testPhone: testPhone.trim(),
          sampleName: previewName.trim() || "Jessica",
          businessName,
          mode: tab,
          customTemplate,
          logoUrl,
          personalizedImage,
        }),
      });
      if (!r.ok) throw new Error();
      showToast("Test message sent");
    } catch {
      showToast("Couldn’t send the test message");
    } finally {
      setSendingTest(false);
    }
  }

  async function onPickImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Local preview immediately
    const localUrl = URL.createObjectURL(file);
    setLogoUrl(localUrl);
    setDirty(true);
    // Real upload -> public URL (this is the value the card service reads as ?bg=)
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("location_id", locationId);
      const r = await fetch(`${API_BASE}/api/upload-logo`, { method: "POST", body: fd });
      if (!r.ok) throw new Error();
      const { url } = await r.json();
      if (url) setLogoUrl(url);
      showToast("Image updated");
    } catch {
      // keep local preview; will need a real upload endpoint in production
    }
  }

  const smsText = useMemo(() => {
    if (tab === "custom") {
      return customTemplate
        .replace(/\{\{\s*first_name\s*\}\}/g, previewName)
        .replace(/\{\{\s*business_name\s*\}\}/g, businessName || "your business");
    }
    return `Hey ${previewName}, we hope you enjoyed your experience with ${
      businessName || "us"
    }! Would you mind taking a moment to leave a review? Here's the link: [Review Link]`;
  }, [tab, customTemplate, businessName, previewName]);

  return (
    <div className="min-h-screen bg-gray-50 px-6 py-8 text-gray-900">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8">
          <h1 className="text-2xl font-bold">Messaging</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure how review requests are sent to your customers
          </p>
        </header>

        {/* top section: preview + config */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          {/* left: live preview */}
          <div>
            <Phone>
              {personalizedImage && (
                <PersonalizedCard businessName={businessName} name={previewName} logoUrl={logoUrl} />
              )}
              <Bubble side="out" time="9:41 AM">
                {smsText}
              </Bubble>
            </Phone>
            <div className="mt-5 flex flex-col items-center gap-2">
              <input
                type="text"
                value={previewName}
                onChange={(e) => setPreviewName(e.target.value)}
                placeholder="Test name (e.g. Jessica)"
                aria-label="Test name"
                className="w-56 rounded-lg border border-gray-300 px-3 py-2 text-center text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
              />
              <input
                type="tel"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="+1 555 123 4567"
                className="w-56 rounded-lg border border-gray-300 px-3 py-2 text-center text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
              />
              <button
                type="button"
                onClick={sendTest}
                disabled={sendingTest}
                className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
                style={{ backgroundColor: GREEN }}
              >
                {sendingTest ? "Sending…" : "Send test message"}
              </button>
            </div>
          </div>

          {/* right: config */}
          <div className="space-y-4">
            {/* sending mode banner */}
            <div className="rounded-xl border border-green-200 bg-green-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex gap-3">
                  <div className="mt-0.5 rounded-lg bg-white p-1.5">
                    <Sparkles className="h-5 w-5" style={{ color: GREEN }} />
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                      Current sending mode
                    </div>
                    <div className="text-sm font-bold">
                      {smartEnabled ? "Smart messaging is on" : "Custom message is on"}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-600">
                      {smartEnabled
                        ? "Review requests use optimized, continuously tested message templates."
                        : "Review requests use your custom message exactly as written."}
                    </p>
                  </div>
                </div>
                <span
                  className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white"
                  style={{ backgroundColor: GREEN }}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> On
                </span>
              </div>
            </div>

            {/* tabs */}
            <div className="grid grid-cols-2 gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1">
              {[
                { id: "smart", label: "Smart message", Icon: Sparkles },
                { id: "custom", label: "Custom message", Icon: MessageSquare },
              ].map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setTab(id);
                    setSmartEnabled(id === "smart");
                    setDirty(true);
                  }}
                  className={`flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold transition-colors ${
                    tab === id ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>

            {/* smart vs custom body */}
            {tab === "smart" ? (
              <Card className="p-4">
                <div className="mb-1 flex items-center gap-2">
                  <Sparkles className="h-5 w-5" style={{ color: GREEN }} />
                  <h3 className="text-base font-bold">Smart messaging</h3>
                </div>
                <p className="mb-3 text-sm text-gray-500">
                  Messages that get tested and tuned to lift your response rate over time.
                </p>
                <div className="rounded-lg border border-gray-100 bg-gradient-to-b from-green-50 to-white p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" style={{ color: GREEN }} />
                    <span className="text-sm font-bold">Highest-converting messages</span>
                  </div>
                  <p className="mb-2 text-xs text-gray-600">
                    Variations are tested across thousands of requests to find what lands best.
                  </p>
                  <ul className="space-y-1.5">
                    {[
                      "Multiple message styles tested automatically",
                      "Learns which tone resonates with your customers",
                      "Continuously tuned for higher click rates",
                    ].map((t) => (
                      <li key={t} className="flex items-center gap-2 text-xs text-gray-700">
                        <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: GREEN }} /> {t}
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>
            ) : (
              <Card className="p-4">
                <h3 className="mb-1 text-base font-bold">Custom message</h3>
                <p className="mb-3 text-sm text-gray-500">
                  Write your own. Use the tags below — they’re filled in per customer when the text sends.
                </p>
                <textarea
                  value={customTemplate}
                  onChange={(e) => edit(setCustomTemplate)(e.target.value)}
                  rows={5}
                  className="w-full rounded-lg border border-gray-300 p-3 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {["{{first_name}}", "{{business_name}}", "[Review Link]"].map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => edit(setCustomTemplate)(customTemplate + " " + tag)}
                      className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </Card>
            )}

            {/* identity fields */}
            <Card className="space-y-4 p-4">
              <Field label="Owner first name" value={ownerName} onChange={edit(setOwnerName)} placeholder="Matt" />
              <Field
                label="Business name"
                value={businessName}
                onChange={edit(setBusinessName)}
                placeholder="PRVT MKT"
              />
              <button
                type="button"
                onClick={saveConfig}
                disabled={!dirty || saving}
                className="w-full rounded-lg py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                style={dirty && !saving ? { backgroundColor: GREEN, color: "white" } : {}}
              >
                {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
              </button>
            </Card>

            {/* personalized image */}
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-lg bg-gray-100 p-1.5">
                    <ImageIcon className="h-5 w-5 text-gray-700" />
                  </div>
                  <div>
                    <div className="text-sm font-bold">Personalized image</div>
                    <p className="text-xs text-gray-500">Adds a custom image with each customer’s name</p>
                  </div>
                </div>
                <Toggle checked={personalizedImage} onChange={edit(setPersonalizedImage)} label="Personalized image" />
              </div>

              {personalizedImage && (
                <div className="mt-4 flex items-center gap-4">
                  <div
                    className="flex h-20 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg"
                    style={{ backgroundColor: "#0b0b0c" }}
                  >
                    {logoUrl ? (
                      <img src={logoUrl} alt="Brand" className="h-full w-full object-cover" />
                    ) : (
                      <span className="px-2 text-center text-[11px] font-extrabold uppercase tracking-widest text-white">
                        {businessName || "Your Business"}
                      </span>
                    )}
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      <ImageIcon className="h-4 w-4" /> Change image
                    </button>
                    <p className="mt-1.5 text-[11px] text-gray-400">PNG or JPG. This becomes the card background.</p>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>

        {/* divider */}
        <div className="my-10 border-t border-gray-200" />

        {/* follow-up section */}
        <section>
          <h2 className="text-xl font-bold">Follow-up messages</h2>
          <p className="mt-1 text-sm text-gray-500">Lift your review rate with automated reminders</p>

          <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-2">
            <Phone>
              <Bubble side="out" time="2:30 PM">
                Hey {previewName}, just following up — we’d really appreciate your feedback! [Review Link]
              </Bubble>
              <Bubble side="in" time="2:45 PM">
                Just left a review! Thanks for your help!
              </Bubble>
            </Phone>

            <div className="space-y-4">
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-lg bg-green-50 p-1.5">
                      <TrendingUp className="h-5 w-5" style={{ color: GREEN }} />
                    </div>
                    <div>
                      <div className="text-sm font-bold">Enable follow-ups</div>
                      <p className="text-xs text-gray-500">Automatically remind customers who haven’t left a review</p>
                    </div>
                  </div>
                  <Toggle checked={followUps} onChange={edit(setFollowUps)} label="Enable follow-ups" />
                </div>
                {followUps && (
                  <div className="mt-3 flex gap-2 rounded-lg bg-green-50 p-3">
                    <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: GREEN }} />
                    <p className="text-xs text-gray-700">
                      <span className="font-semibold">A big share of reviews come from follow-ups.</span> Gentle reminders
                      go only to customers who haven’t reviewed yet.
                    </p>
                  </div>
                )}
              </Card>

              <Card className="p-4">
                <h3 className="mb-3 text-sm font-bold">How follow-ups work</h3>
                <ul className="space-y-3">
                  {[
                    { Icon: Clock, t: "Automatic timing", d: "First reminder goes out 3 days after the initial message" },
                    { Icon: Bell, t: "Up to 3 reminders", d: "Spaced out over time for the best response" },
                    { Icon: CheckCircle2, t: "Smart stop", d: "Stops the moment a customer clicks or replies" },
                    { Icon: CalendarDays, t: "Business hours only", d: "Sent at appropriate times for your customers" },
                  ].map(({ Icon, t, d }) => (
                    <li key={t} className="flex gap-3">
                      <div className="mt-0.5 rounded-lg bg-gray-100 p-1.5">
                        <Icon className="h-4 w-4 text-gray-600" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold">{t}</div>
                        <div className="text-xs text-gray-500">{d}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </section>
      </div>

      {/* toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
