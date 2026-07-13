// home/ContactDrawer.jsx — the contact pop-out: a right slide-over specific to
// our offering. Shows and MANAGES everything this app cares about for one
// contact: DND, queue membership (the 4 tags), our section custom fields, a
// send-card action per queue, and the timeline (our card sends + SMS thread).

import React, { useEffect, useMemo, useState } from "react";
import { X, Ban, Phone, Mail, CalendarDays } from "lucide-react";
import * as api from "./api.js";
import { Pill, Toggle, SendButton, SecondaryButton, SECTION_LABELS, BLUE } from "./ui.jsx";

const QUEUE_PILL = { quotes: "scheduled", reviews: "due", winback: "aged", offers: "proven" };

const fmtDate = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const fmtDateTime = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export default function ContactDrawer({ contactId, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState({});
  const [tab, setTab] = useState("sends");
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setEdits({});
    setNotice(null);
    api.getContactDetail(contactId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setError(e.message || "Couldn’t load contact"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contactId]);

  const contact = detail?.contact;
  const dirty = Object.keys(edits).length > 0;

  async function applyPatch(body, successNote) {
    setBusy(true);
    setNotice(null);
    try {
      const d = await api.patchContact(contactId, body);
      setDetail(d);
      setEdits({});
      if (successNote) setNotice({ kind: "ok", text: successNote });
      onChanged?.(d.contact);
    } catch (e) {
      setNotice({ kind: "err", text: e.message || "Couldn’t save" });
    } finally {
      setBusy(false);
    }
  }

  async function sendCard(section) {
    const name = contact?.firstName || contact?.name || "this contact";
    if (detail?.sendsEnabled === false) {
      setBusy(true);
      try {
        const r = await api.sendOne(section, contactId, { dryRun: true });
        setNotice({ kind: "ok", text: `Dry run — would send the ${SECTION_LABELS[section]} card to ${name} (live sending is off).` });
      } catch (e) {
        setNotice({ kind: "err", text: e.message || "Dry run failed" });
      } finally { setBusy(false); }
      return;
    }
    if (!window.confirm(`Send the ${SECTION_LABELS[section]} card to ${name}?\n\nThis texts a real person and can’t be undone.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.sendOne(section, contactId, { dryRun: false });
      if (r.skipped === "dnd") setNotice({ kind: "err", text: "Refused — contact is opted out (DND)." });
      else if (r.skipped === "recent") setNotice({ kind: "err", text: "Skipped — already sent within 24h." });
      else setNotice({ kind: "ok", text: `Sent — the ${SECTION_LABELS[section]} workflow is running.` });
      // Refresh the timeline.
      api.getContactDetail(contactId).then(setDetail).catch(() => {});
    } catch (e) {
      setNotice({ kind: "err", text: e.message || "Send failed" });
    } finally { setBusy(false); }
  }

  if (!contactId) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="border-b border-gray-200 p-5">
          <div className="flex items-start justify-between">
            <div className="min-w-0">
              <h3 className="truncate text-lg font-bold text-gray-900">{contact?.name || "…"}</h3>
              <div className="mt-0.5 text-xs text-gray-500">Added {fmtDate(contact?.addedAt)}</div>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
              <X className="h-5 w-5" />
            </button>
          </div>

          {contact ? (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {(contact.queues || []).map((q) => (
                  <Pill key={q} variant={QUEUE_PILL[q] || "neutral"}>{SECTION_LABELS[q]}</Pill>
                ))}
                {contact.dnd ? <Pill variant="agedFar">Do Not Contact</Pill> : null}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => applyPatch({ dnd: !contact.dnd }, contact.dnd ? "Contact can be messaged again." : "Marked Do Not Contact — excluded from every send.")}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                    contact.dnd
                      ? "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                      : "border-rose-200 bg-white text-rose-600 hover:bg-rose-50"
                  }`}
                >
                  <Ban className="h-4 w-4" />
                  {contact.dnd ? "Allow contact" : "Do Not Contact"}
                </button>
              </div>
              <div className="mt-3 space-y-1.5 text-sm text-gray-700">
                <div className="flex items-center gap-2"><Phone className="h-3.5 w-3.5 text-gray-400" />{contact.phone || "—"}</div>
                <div className="flex items-center gap-2"><Mail className="h-3.5 w-3.5 text-gray-400" />{contact.email || "—"}</div>
              </div>
            </>
          ) : null}
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />)}
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          ) : detail ? (
            <>
              {/* queues */}
              <div className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-400">Queues</div>
              <div className="mb-5 overflow-hidden rounded-xl border border-gray-200">
                {Object.entries(SECTION_LABELS).map(([key, label], i) => {
                  const on = (contact?.queues || []).includes(key);
                  return (
                    <div key={key} className={`flex items-center justify-between px-4 py-2.5 ${i > 0 ? "border-t border-gray-100" : ""}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-800">{label}</span>
                        {on ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => sendCard(key)}
                            className="text-xs font-semibold text-blue-600 underline hover:text-blue-800 disabled:opacity-50"
                          >
                            send card
                          </button>
                        ) : null}
                      </div>
                      <Toggle
                        checked={on}
                        disabled={busy}
                        label={`${label} queue`}
                        onChange={(v) => applyPatch({ queues: { [key]: v } }, v ? `Added to ${label}.` : `Removed from ${label}.`)}
                      />
                    </div>
                  );
                })}
              </div>

              {/* our fields */}
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wide text-gray-400">Fields</span>
                {Object.values(detail.fields || {}).some((defs) => defs.some((f) => !f.defined)) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setNotice(null);
                      try {
                        const r = await api.setupFields();
                        setNotice({ kind: "ok", text: `Created ${r.created.length} field${r.created.length === 1 ? "" : "s"} in GHL — they're editable now.` });
                        const d = await api.getContactDetail(contactId);
                        setDetail(d);
                      } catch (e) {
                        setNotice({ kind: "err", text: e.message || "Couldn’t create the fields" });
                      } finally {
                        setBusy(false);
                      }
                    }}
                    className="text-xs font-semibold text-blue-600 underline hover:text-blue-800 disabled:opacity-50"
                  >
                    Set up missing fields
                  </button>
                ) : null}
              </div>
              <div className="mb-2 overflow-hidden rounded-xl border border-gray-200">
                {Object.entries(detail.fields || {}).map(([section, defs]) => (
                  <div key={section} className="border-t border-gray-100 first:border-t-0">
                    <div className="bg-gray-50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      {SECTION_LABELS[section]}
                    </div>
                    {defs.map((f) => (
                      <div key={f.key} className="flex items-center justify-between gap-3 px-4 py-2">
                        <label className="text-sm text-gray-600">
                          {f.label}
                          {!f.defined ? <span className="ml-1 text-[10px] text-amber-500" title="Custom field not created in GHL yet">not set up</span> : null}
                        </label>
                        <input
                          type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                          value={edits[f.key] !== undefined ? edits[f.key] : f.value}
                          disabled={!f.defined || busy}
                          onChange={(e) => setEdits((p) => ({ ...p, [f.key]: e.target.value }))}
                          className="w-40 rounded-lg border border-gray-300 px-2.5 py-1.5 text-right text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50 disabled:text-gray-400"
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              {dirty ? (
                <div className="mb-5 grid grid-cols-2 gap-2">
                  <SecondaryButton onClick={() => setEdits({})} disabled={busy}>Discard</SecondaryButton>
                  <SendButton onClick={() => applyPatch({ fields: edits }, "Fields saved.")} busy={busy}>Save fields</SendButton>
                </div>
              ) : <div className="mb-5" />}

              {/* timeline */}
              <div className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-400">Timeline</div>
              <div className="mb-2 grid grid-cols-2 overflow-hidden rounded-lg border border-gray-200 text-sm font-medium">
                {[["sends", "Card sends"], ["messages", "Messages"]].map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setTab(k)}
                    className={`py-2 ${tab === k ? "bg-gray-900 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {tab === "sends" ? (
                (detail.sends || []).length === 0 ? (
                  <div className="rounded-lg border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
                    No cards sent yet.
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-gray-200">
                    {detail.sends.map((s, i) => (
                      <div key={i} className={`flex items-center justify-between px-4 py-2.5 ${i > 0 ? "border-t border-gray-100" : ""}`}>
                        <div className="flex items-center gap-2">
                          <Pill variant={QUEUE_PILL[s.section] || "neutral"}>{SECTION_LABELS[s.section] || s.section}</Pill>
                          <span className="text-xs text-gray-500">{fmtDateTime(s.createdAt)}</span>
                        </div>
                        {s.cardUrl ? (
                          <a href={s.cardUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-blue-600 underline hover:text-blue-800">
                            view card
                          </a>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )
              ) : (detail.messages || []).length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
                  No messages yet.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {detail.messages.map((m) => {
                    const out = m.direction === "outbound";
                    return (
                      <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                        <div className="max-w-[85%]">
                          <div
                            className="rounded-2xl px-3 py-2 text-[13px] leading-snug"
                            style={out ? { backgroundColor: BLUE, color: "white" } : { backgroundColor: "#f3f4f6", color: "#111827" }}
                          >
                            {m.body || (m.attachments?.length ? "📎 attachment" : "")}
                          </div>
                          <div className={`mt-0.5 text-[10px] text-gray-400 ${out ? "text-right" : ""}`}>{fmtDateTime(m.dateAdded)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* notice bar */}
        {notice ? (
          <div className={`border-t px-5 py-2.5 text-sm ${notice.kind === "ok" ? "border-green-100 bg-green-50 text-green-800" : "border-red-100 bg-red-50 text-red-700"}`}>
            {notice.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}
