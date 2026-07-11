import React, { useState, useEffect, useMemo, useRef } from "react";
import { MessageSquare, Image as ImageIcon } from "lucide-react";
import CardStudio from "./studio/CardStudio.jsx";
import TemplatePreview from "./studio/TemplatePreview.jsx";

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

const API_BASE = import.meta.env.VITE_API_BASE || "https://prvt-reviews-1.onrender.com"; // broker
const CARD_BASE = import.meta.env.VITE_CARD_BASE || "https://prvt-reviews.onrender.com"; // the card image microservice
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

/* The personalized card — a TRUE preview: an <img> pointing at the live card
   microservice, so what you see is exactly what gets sent (same renderer). */
function PersonalizedCard({ src }) {
  return (
    <div
      className="relative mb-2 aspect-square w-full overflow-hidden rounded-xl"
      style={{ backgroundColor: "#0b0b0c" }}
    >
      {src ? (
        <img src={src} alt="Card preview" className="h-full w-full object-cover" />
      ) : null}
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

  const [tab] = useState("custom"); // single message mode (Smart/Custom tabs removed)
  const [ownerName, setOwnerName] = useState("Matt");
  const [businessName, setBusinessName] = useState("PRVT MKT");
  const [logoUrl, setLogoUrl] = useState(null);
  const [personalizedImage, setPersonalizedImage] = useState(true);
  const [smartEnabled, setSmartEnabled] = useState(true);
  const [followUps, setFollowUps] = useState(true);
  const [customTemplate, setCustomTemplate] = useState(
    "Hey {{first_name}}, we hope you enjoyed your experience with {{business_name}}! Would you mind taking a moment to leave a review? Here's the link: [Review Link]"
  );
  const [reviewLink, setReviewLink] = useState("");
  const [cardFit, setCardFit] = useState("cover"); // "cover" | "contain"
  const [cardBgColor, setCardBgColor] = useState("");
  const [cardHeadline, setCardHeadline] = useState("");
  const [cardAccent, setCardAccent] = useState("");
  const [cardNameX, setCardNameX] = useState(0.5); // 0..1 pill center, horizontal
  const [cardNameY, setCardNameY] = useState(0.7); // 0..1 pill center, vertical

  // Send engine — multi-recipient
  const [recipients, setRecipients] = useState([]); // [{ id?, phone?, firstName? }]
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [manualPhone, setManualPhone] = useState("");
  const [sendTag, setSendTag] = useState("");
  const [tagList, setTagList] = useState([]);
  const [audiencePreview, setAudiencePreview] = useState(null);
  const [sendResult, setSendResult] = useState(null);
  const [sendBusy, setSendBusy] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [toast, setToast] = useState(null);

  const [previewName, setPreviewName] = useState("Jessica");
  // The template currently selected in the Card Studio → used to route sends.
  const [studioTemplate, setStudioTemplate] = useState(null);

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
        if (c.customTemplate) setCustomTemplate(c.customTemplate);
        if (c.reviewLink != null) setReviewLink(c.reviewLink);
        if (c.cardFit) setCardFit(c.cardFit);
        if (c.cardBgColor != null) setCardBgColor(c.cardBgColor);
        if (c.cardHeadline != null) setCardHeadline(c.cardHeadline);
        if (c.cardAccent != null) setCardAccent(c.cardAccent);
        if (c.cardNameX != null && c.cardNameX !== "") setCardNameX(parseFloat(c.cardNameX));
        if (c.cardNameY != null && c.cardNameY !== "") setCardNameY(parseFloat(c.cardNameY));
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
          reviewLink,
          cardFit,
          cardBgColor,
          cardHeadline,
          cardAccent,
          cardNameX,
          cardNameY,
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
      // Route through the Card Studio pipeline when a saved template is
      // selected; otherwise fall back to the legacy card sender.
      if (personalizedImage && studioTemplate?.id) {
        const r = await fetch(`${API_BASE}/api/render/test-send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location_id: locationId,
            templateId: studioTemplate.id,
            testPhone: testPhone.trim(),
            sampleName: previewName.trim() || "Jessica",
            message: smsText,
          }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "failed");
        showToast("Test message sent");
        return;
      }
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
          reviewLink: reviewLink.trim() || "[Review Link]",
          cardFit,
          cardBgColor,
          cardHeadline,
          cardAccent,
          cardNameX,
          cardNameY,
        }),
      });
      if (!r.ok) throw new Error();
      showToast("Test message sent");
    } catch (e) {
      showToast("Couldn’t send the test message" + (e.message ? ` — ${e.message}` : ""));
    } finally {
      setSendingTest(false);
    }
  }

  // Load available tags for the audience picker.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/tags?location_id=${encodeURIComponent(locationId)}`);
        if (!r.ok) return;
        const { tags } = await r.json();
        if (alive && Array.isArray(tags)) setTagList(tags.map((t) => t.name || t).filter(Boolean));
      } catch {
        /* no tags available */
      }
    })();
    return () => {
      alive = false;
    };
  }, [locationId]);

  // Debounced contact typeahead for the recipient picker.
  useEffect(() => {
    if (!contactQuery.trim()) {
      setContactResults([]);
      return;
    }
    setContactSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `${API_BASE}/api/contacts?location_id=${encodeURIComponent(locationId)}&query=${encodeURIComponent(
            contactQuery.trim()
          )}`
        );
        const data = await r.json();
        setContactResults(Array.isArray(data.contacts) ? data.contacts : []);
      } catch {
        setContactResults([]);
      } finally {
        setContactSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [contactQuery, locationId]);

  const keyOf = (r) => r.id || r.phone;

  function addRecipient(r) {
    setAudiencePreview(null);
    setRecipients((prev) => (prev.some((p) => keyOf(p) === keyOf(r)) ? prev : [...prev, r]));
  }
  function removeRecipient(key) {
    setAudiencePreview(null);
    setRecipients((prev) => prev.filter((p) => keyOf(p) !== key));
  }
  function addManualPhone() {
    const p = manualPhone.trim();
    if (!p) return;
    addRecipient({ phone: p });
    setManualPhone("");
  }

  // Payload for /api/send-batch. Message is a token template; the broker
  // personalizes it per contact. Card image settings ride along as `card`.
  function sendBatchBody(dryRun) {
    const messageTemplate =
      tab === "custom"
        ? customTemplate
        : "Hey {{first_name}}, we hope you enjoyed your experience with {{business_name}}! " +
          "Would you mind taking a moment to leave a review? Here's the link: [Review Link]";
    return {
      location_id: locationId,
      dryRun,
      contacts: recipients.filter((r) => r.id).map((r) => ({ id: r.id, firstName: r.firstName })),
      phones: recipients.filter((r) => !r.id && r.phone).map((r) => r.phone),
      tag: sendTag || "",
      message: messageTemplate,
      businessName,
      reviewLink: reviewLink.trim(),
      templateId: personalizedImage && studioTemplate?.id ? studioTemplate.id : "",
      card: {
        logoUrl: personalizedImage && /^https?:/i.test(logoUrl || "") ? logoUrl : "",
        cardFit,
        cardBgColor,
        cardHeadline: cardHeadline.trim(),
        cardAccent,
        cardNameX,
        cardNameY,
      },
    };
  }

  async function runSend(dryRun) {
    if (recipients.length === 0 && !sendTag) return showToast("Add at least one recipient or a tag");
    setSendBusy(true);
    if (dryRun) setSendResult(null);
    try {
      const r = await fetch(`${API_BASE}/api/send-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sendBatchBody(dryRun)),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "failed");
      if (dryRun) {
        setAudiencePreview(data);
      } else {
        setSendResult(data);
        showToast(data.sent != null ? `Sent to ${data.sent}` : "Sent");
      }
    } catch (e) {
      showToast(`Couldn’t ${dryRun ? "preview" : "send"} — ${e.message}`);
    } finally {
      setSendBusy(false);
    }
  }

  async function confirmAndSend() {
    const n = audiencePreview?.willSend ?? recipients.length;
    if (!window.confirm(`Send the card to ${n} recipient${n === 1 ? "" : "s"}? This texts real people and can’t be undone.`))
      return;
    await runSend(false);
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

  // Build the real card-service URL for the live preview. Only pass bg when
  // it's a hosted http(s) URL (a freshly-picked local blob can't be fetched
  // by the card service).
  const cardUrl = useMemo(() => {
    const p = new URLSearchParams({ name: previewName.trim() || "Jessica" });
    if (logoUrl && /^https?:/i.test(logoUrl)) p.set("bg", logoUrl);
    if (cardFit) p.set("fit", cardFit);
    if (cardBgColor) p.set("bgColor", cardBgColor);
    if (cardHeadline.trim()) p.set("headline", cardHeadline.trim());
    if (cardAccent) p.set("accent", cardAccent);
    p.set("nameX", cardNameX);
    p.set("nameY", cardNameY);
    return `${CARD_BASE}/card?${p.toString()}`;
  }, [previewName, logoUrl, cardFit, cardBgColor, cardHeadline, cardAccent, cardNameX, cardNameY]);

  // Debounce so typing a headline / dragging a color picker doesn't hammer the
  // card service on every keystroke.
  const [previewSrc, setPreviewSrc] = useState(cardUrl);
  useEffect(() => {
    const t = setTimeout(() => setPreviewSrc(cardUrl), 400);
    return () => clearTimeout(t);
  }, [cardUrl]);

  const smsText = useMemo(() => {
    const link = reviewLink.trim() || "[Review Link]";
    if (tab === "custom") {
      return customTemplate
        .replace(/\{\{\s*first_name\s*\}\}/g, previewName)
        .replace(/\{\{\s*business_name\s*\}\}/g, businessName || "your business")
        .replace(/\[Review Link\]/g, link);
    }
    return `Hey ${previewName}, we hope you enjoyed your experience with ${
      businessName || "us"
    }! Would you mind taking a moment to leave a review? Here's the link: ${link}`;
  }, [tab, customTemplate, businessName, previewName, reviewLink]);

  return (
    <div className="min-h-screen bg-gray-50 px-6 py-4 text-gray-900">
      <div className="mx-auto max-w-none 2xl:max-w-[1800px]">
        {/* trifold: preview | card studio + message | send */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,340px)]">
          {/* left: live preview (sticky) */}
          <div className="lg:sticky lg:top-6 lg:self-start">
            <Phone>
              {personalizedImage &&
                (studioTemplate?.layers?.length ? (
                  // Live mirror of the Card Studio template — updates on every edit.
                  <div className="mb-2 overflow-hidden rounded-xl">
                    <TemplatePreview template={studioTemplate} />
                  </div>
                ) : (
                  <PersonalizedCard src={previewSrc} />
                ))}
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

          {/* middle: card studio + message */}
          <div className="min-w-0 space-y-4">
            {/* personalized image — Dynamic Card Studio */}
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-lg bg-gray-100 p-1.5">
                    <ImageIcon className="h-5 w-5 text-gray-700" />
                  </div>
                  <div>
                    <div className="text-sm font-bold">Card studio</div>
                    <p className="text-xs text-gray-500">Design the personalized image sent with each message</p>
                  </div>
                </div>
                <Toggle checked={personalizedImage} onChange={edit(setPersonalizedImage)} label="Personalized image" />
              </div>
              {personalizedImage && <CardStudio onTemplateChange={setStudioTemplate} />}
            </Card>

            {/* message */}
            <Card className="p-4">
              <h3 className="mb-1 text-base font-bold">Message</h3>
              <p className="mb-3 text-sm text-gray-500">
                The text that sends with the card. Tags are filled in per customer when the text sends.
              </p>
              <textarea
                value={customTemplate}
                onChange={(e) => edit(setCustomTemplate)(e.target.value)}
                rows={5}
                className="w-full rounded-lg border border-gray-300 p-3 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {["{{first_name}}", "{{business_name}}"].map((tag) => (
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
              <button
                type="button"
                onClick={saveConfig}
                disabled={!dirty || saving}
                className="mt-3 w-full rounded-lg py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                style={dirty && !saving ? { backgroundColor: GREEN, color: "white" } : {}}
              >
                {saving ? "Saving…" : dirty ? "Save message" : "Saved"}
              </button>
            </Card>
          </div>

          {/* right: send a card */}
          <div className="space-y-4">

            {/* send a card */}
            <Card className="space-y-4 p-4">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-gray-700" />
                  <h3 className="text-base font-bold">Send a card</h3>
                </div>
                <p className="text-sm text-gray-500">
                  Send the card you designed to specific people, a whole tag, or both.
                </p>
              </div>
              {/* recipient search */}
              <div>
                <label className="mb-1 block text-sm font-semibold text-gray-900">Add people</label>
                <input
                  type="text"
                  value={contactQuery}
                  onChange={(e) => setContactQuery(e.target.value)}
                  placeholder="Search contacts by name or phone…"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                />
                {(contactSearching || contactResults.length > 0 || contactQuery.trim()) && (
                  <div className="mt-1 max-h-44 overflow-auto rounded-lg border border-gray-200">
                    {contactSearching && <div className="px-3 py-2 text-xs text-gray-400">Searching…</div>}
                    {contactResults.map((c) => {
                      const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "Unnamed";
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            addRecipient({ id: c.id, firstName: c.firstName, phone: c.phone });
                            setContactQuery("");
                            setContactResults([]);
                          }}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50"
                        >
                          <span className="font-medium text-gray-800">{name}</span>
                          <span className="text-xs text-gray-400">{c.phone}</span>
                        </button>
                      );
                    })}
                    {!contactSearching && contactResults.length === 0 && contactQuery.trim() && (
                      <div className="px-3 py-2 text-xs text-gray-400">No matches</div>
                    )}
                  </div>
                )}
              </div>

              {/* manual phone */}
              <div className="flex gap-2">
                <input
                  type="tel"
                  value={manualPhone}
                  onChange={(e) => setManualPhone(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addManualPhone();
                    }
                  }}
                  placeholder="Or add a phone number…"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                />
                <button
                  type="button"
                  onClick={addManualPhone}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Add
                </button>
              </div>

              {/* tag audience */}
              <div>
                <label className="mb-1 block text-sm font-semibold text-gray-900">Or include a whole tag</label>
                <select
                  value={sendTag}
                  onChange={(e) => {
                    setSendTag(e.target.value);
                    setAudiencePreview(null);
                  }}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                >
                  <option value="">{tagList.length ? "No tag" : "No tags found"}</option>
                  {tagList.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-gray-400">
                  Sends to everyone with this tag. Hit “Preview audience” to see the count first.
                </p>
              </div>

              {/* selected recipients */}
              {(recipients.length > 0 || sendTag) && (
                <div className="rounded-lg border border-gray-200 p-2">
                  <div className="mb-1.5 text-xs font-semibold text-gray-500">
                    Recipients
                    {recipients.length ? ` · ${recipients.length} selected` : ""}
                    {sendTag ? ` · tag "${sendTag}"` : ""}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {sendTag && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700">
                        tag: {sendTag}
                        <button
                          type="button"
                          onClick={() => setSendTag("")}
                          className="text-green-500 hover:text-green-700"
                        >
                          ×
                        </button>
                      </span>
                    )}
                    {recipients.map((r) => (
                      <span
                        key={keyOf(r)}
                        className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700"
                      >
                        {r.firstName || r.phone}
                        <button
                          type="button"
                          onClick={() => removeRecipient(keyOf(r))}
                          className="text-gray-400 hover:text-gray-700"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => runSend(true)}
                disabled={sendBusy}
                className="w-full rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                {sendBusy ? "Checking…" : "Preview audience (no send)"}
              </button>

              {audiencePreview && (
                <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-700">
                  <div>
                    <span className="font-semibold">{audiencePreview.willSend}</span> will receive it
                    {audiencePreview.skippedDnd ? ` · ${audiencePreview.skippedDnd} skipped (opted out)` : ""}.
                  </div>
                  {audiencePreview.willSend >= audiencePreview.cap && (
                    <div className="text-amber-600">Capped at {audiencePreview.cap} per run.</div>
                  )}
                  {audiencePreview.sample?.length ? (
                    <div className="mt-1 text-gray-500">e.g. {audiencePreview.sample.join(", ")}</div>
                  ) : null}
                  {audiencePreview.sendsEnabled === false && (
                    <div className="mt-2 rounded bg-amber-50 p-2 text-amber-700">
                      Live sending is OFF. Set <code>CARD_SENDS_ENABLED=true</code> on the broker to enable real sends.
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={confirmAndSend}
                disabled={sendBusy || !audiencePreview || audiencePreview.sendsEnabled === false}
                className="w-full rounded-lg py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                style={{ backgroundColor: GREEN }}
              >
                {sendBusy
                  ? "Sending…"
                  : !audiencePreview
                  ? "Preview audience first"
                  : audiencePreview.sendsEnabled === false
                  ? "Live sending is off"
                  : "Send for real"}
              </button>

              {sendResult && (
                <div className={`rounded-lg p-3 text-xs ${sendResult.failed ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-800"}`}>
                  Sent {sendResult.sent}.{" "}
                  {sendResult.failed ? `${sendResult.failed} failed. ` : ""}
                  {sendResult.skippedDnd ? `${sendResult.skippedDnd} skipped.` : ""}
                  {sendResult.errors?.length > 0 && (
                    <ul className="mt-1 list-disc pl-4">
                      {sendResult.errors.map((e, i) => (
                        <li key={i}><span className="font-medium">{e.who}:</span> {e.error}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Card>
            <p className="text-[11px] text-gray-400">
              Sends the card + message exactly as previewed above. Contacts who opted out (DND) are skipped
              automatically. You’re responsible for having consent to message these contacts.
            </p>
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
  );
}
