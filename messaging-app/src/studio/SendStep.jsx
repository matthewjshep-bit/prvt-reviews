// SendStep.jsx — step 3 of the Card Studio flow: the ad-hoc sender. Send the
// card you just designed to hand-picked people, a phone number, or a whole
// tag. Queue-based daily sends stay on the Home sections; this is for
// one-offs, tests, and tag blasts. Extracted from MessagingPage's "Send a
// card" block; posts the same /api/send-batch payload.

import React, { useEffect, useMemo, useState } from "react";
import { API_BASE, getLocationId } from "./api.js";
import TemplatePreview from "./TemplatePreview.jsx";
import { resolveBindings, flatToContext } from "@shared/bindings.js";

const BLUE = "#4c6ef5";
const SEND_BLUE = "#1d4ed8";

export default function SendStep({ template, templateId, dirty, onRequestSave, message, onEditDesign, businessName, reviewLink }) {
  const locationId = getLocationId();

  // audience state (self-owned)
  const [recipients, setRecipients] = useState([]);
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [manualPhone, setManualPhone] = useState("");
  const [sendTag, setSendTag] = useState("");
  const [tagList, setTagList] = useState([]);
  const [audiencePreview, setAudiencePreview] = useState(null);
  const [sendResult, setSendResult] = useState(null);
  const [sendBusy, setSendBusy] = useState(false);

  // tags for the audience picker
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/tags?location_id=${encodeURIComponent(locationId)}`);
        const d = await r.json();
        if (Array.isArray(d.tags)) setTagList(d.tags.map((t) => t.name || t).filter(Boolean));
      } catch { /* ignore */ }
    })();
  }, [locationId]);

  // debounced contact typeahead
  useEffect(() => {
    if (!contactQuery.trim()) { setContactResults([]); return; }
    setContactSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/contacts?location_id=${encodeURIComponent(locationId)}&query=${encodeURIComponent(contactQuery.trim())}`);
        const d = await r.json();
        setContactResults(Array.isArray(d.contacts) ? d.contacts : []);
      } catch {
        setContactResults([]);
      } finally {
        setContactSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [contactQuery, locationId]);

  const keyOf = (r) => r.id || r.phone;
  const addRecipient = (r) => {
    setAudiencePreview(null);
    setRecipients((prev) => (prev.some((p) => keyOf(p) === keyOf(r)) ? prev : [...prev, r]));
  };
  const removeRecipient = (key) => {
    setAudiencePreview(null);
    setRecipients((prev) => prev.filter((p) => keyOf(p) !== key));
  };

  async function runSend(dryRun) {
    if (recipients.length === 0 && !sendTag) { setSendResult({ error: "Add at least one recipient or a tag." }); return; }
    setSendBusy(true);
    if (dryRun) setSendResult(null);
    try {
      const r = await fetch(`${API_BASE}/api/send-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: locationId,
          dryRun,
          contacts: recipients.filter((x) => x.id).map((x) => ({ id: x.id, firstName: x.firstName })),
          phones: recipients.filter((x) => !x.id && x.phone).map((x) => x.phone),
          tag: sendTag || "",
          message,
          businessName: businessName || "",
          reviewLink: (reviewLink || "").trim(),
          templateId,
          card: {},
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "failed");
      if (dryRun) setAudiencePreview(data);
      else setSendResult(data);
    } catch (e) {
      setSendResult({ error: e.message });
    } finally {
      setSendBusy(false);
    }
  }
  async function confirmAndSend() {
    const n = audiencePreview?.willSend ?? recipients.length;
    if (!window.confirm(`Send this card to ${n} recipient${n === 1 ? "" : "s"}?\n\nThis texts real people and can’t be undone.`)) return;
    await runSend(false);
  }

  // preview bubble: resolve tokens against the template's sample data
  const previewText = useMemo(() => {
    const ctx = flatToContext(template?.sampleData || {});
    return resolveBindings(
      String(message || "")
        .replace(/\{\{\s*first_name\s*\}\}/g, "{{contact.first_name}}")
        .replace(/\{\{\s*business_name\s*\}\}/g, businessName || "your business")
        .replace(/\[Review Link\]/g, (reviewLink || "").trim() || "[Review Link]"),
      ctx
    ).value;
  }, [message, template, businessName, reviewLink]);

  if (!templateId || dirty) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
        <div className="text-sm font-semibold text-amber-800">Save your card first</div>
        <p className="mt-1 text-sm text-amber-700">Sending uses the saved version, so save your design before this step.</p>
        <button
          type="button"
          onClick={onRequestSave}
          className="mt-3 rounded-lg px-4 py-2 text-sm font-semibold text-white"
          style={{ backgroundColor: SEND_BLUE }}
        >
          Save card
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      {/* left: what they'll get */}
      <div className="lg:sticky lg:top-24 lg:self-start">
        <div className="overflow-hidden rounded-2xl bg-[#26292f] p-2 shadow-sm">
          <div className="overflow-hidden rounded-xl">
            <TemplatePreview template={template} />
          </div>
          <div className="px-1.5 pb-1 pt-2.5">
            <div className="ml-auto max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-snug text-white" style={{ backgroundColor: BLUE }}>
              {previewText || "Your message will appear here"}
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-gray-400">
          Exactly what recipients get — card + message, filled in per contact.{" "}
          <button type="button" onClick={onEditDesign} className="font-semibold text-blue-600 underline hover:text-blue-800">
            Edit on the Design step
          </button>
        </p>
      </div>

      {/* right: audience only — the message is part of the card design */}
      <div className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <label className="mb-1 block text-sm font-semibold text-gray-900">Who gets it</label>
          <input
            type="text"
            value={contactQuery}
            onChange={(e) => setContactQuery(e.target.value)}
            placeholder="Search contacts by name or phone…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          {(contactSearching || contactResults.length > 0) && (
            <div className="mt-1 max-h-44 overflow-auto rounded-lg border border-gray-200">
              {contactSearching && <div className="px-3 py-2 text-xs text-gray-400">Searching…</div>}
              {contactResults.map((c) => (
                <button key={c.id} type="button"
                  onClick={() => { addRecipient({ id: c.id, firstName: c.firstName, phone: c.phone }); setContactQuery(""); setContactResults([]); }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50">
                  <span className="font-medium text-gray-800">{[c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "Unnamed"}</span>
                  <span className="text-xs text-gray-400">{c.phone}</span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-2 flex gap-2">
            <input
              type="tel"
              value={manualPhone}
              onChange={(e) => setManualPhone(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (manualPhone.trim()) { addRecipient({ phone: manualPhone.trim() }); setManualPhone(""); } } }}
              placeholder="Or add a phone number…"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
            <select
              value={sendTag}
              onChange={(e) => { setSendTag(e.target.value); setAudiencePreview(null); }}
              className="max-w-[45%] rounded-lg border border-gray-300 px-2 py-2 text-sm"
            >
              <option value="">…or a whole tag</option>
              {tagList.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {(recipients.length > 0 || sendTag) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {sendTag && (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                  tag: {sendTag}
                  <button type="button" onClick={() => setSendTag("")} className="text-blue-400 hover:text-blue-700">×</button>
                </span>
              )}
              {recipients.map((r) => (
                <span key={keyOf(r)} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">
                  {r.firstName || r.phone}
                  <button type="button" onClick={() => removeRecipient(keyOf(r))} className="text-gray-400 hover:text-gray-700">×</button>
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => runSend(true)} disabled={sendBusy}
              className="rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {sendBusy ? "Checking…" : "Preview audience"}
            </button>
            <button type="button" onClick={confirmAndSend}
              disabled={sendBusy || !audiencePreview || audiencePreview.sendsEnabled === false}
              className="rounded-lg py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              style={{ backgroundColor: SEND_BLUE }}>
              {!audiencePreview ? "Preview first" : audiencePreview.sendsEnabled === false ? "Sending is off" : "Send for real"}
            </button>
          </div>

          {audiencePreview && (
            <div className="mt-2 rounded-lg bg-gray-50 p-3 text-xs text-gray-700">
              <span className="font-semibold">{audiencePreview.willSend}</span> will receive it
              {audiencePreview.skippedDnd ? ` · ${audiencePreview.skippedDnd} skipped (opted out)` : ""}
              {audiencePreview.willSend >= audiencePreview.cap ? ` · capped at ${audiencePreview.cap}/run` : ""}.
              {audiencePreview.sample?.length ? <div className="mt-1 text-gray-500">e.g. {audiencePreview.sample.join(", ")}</div> : null}
            </div>
          )}
          {sendResult && (
            <div className={`mt-2 rounded-lg p-3 text-xs ${sendResult.error || sendResult.failed ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-800"}`}>
              {sendResult.error
                ? sendResult.error
                : <>Sent {sendResult.sent}. {sendResult.failed ? `${sendResult.failed} failed. ` : ""}{sendResult.skippedDnd ? `${sendResult.skippedDnd} skipped.` : ""}</>}
              {sendResult.errors?.length ? (
                <ul className="mt-1 list-disc pl-4">
                  {sendResult.errors.map((e, i) => <li key={i}><b>{e.who}:</b> {e.error}</li>)}
                </ul>
              ) : null}
            </div>
          )}
          <p className="mt-2 text-[11px] text-gray-400">
            Opted-out (DND) contacts are skipped automatically. Queue-based sends live on the Home sections.
          </p>
        </div>
      </div>
    </div>
  );
}
