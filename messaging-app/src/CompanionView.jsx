// CompanionView.jsx — the companion window (/contact): a narrow app window
// kept beside GoHighLevel that shows whoever is open there (Matt,
// 2026-10-16: "I don't have to toggle back and forth"). The Chrome
// extension (companion-extension/) reads the GHL tab's address and posts
// the person in (companion.js); a GHL conversation page is turned into its
// person by the broker.
//
// The person's Desk pane is on top (their current offer, the conversation
// and reply box, Status · Bot · Edit offer · Call, the same as the Desk), and
// their whole record is under it (ContactDrawer's body). ?contact= keeps the
// person across a reload.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { getContactByConversation, getLocationId, ghlContactUrl } from "./api.js";
import { ContactDrawerContext } from "./ContactLink.jsx";
import { ContactRecordBody } from "./ContactDrawer.jsx";
import { PaneActions, PaneBody, PaneHeading, usePane } from "./PaneParts.jsx";
import { draftsKey, loadDrafts } from "./OfferPane.jsx";
import { forget, useLoad } from "./work-data.js";
import { rowTargets } from "./work-queue.js";
import { COMPANION_HELLO, companionPaneItem, readCompanionMessage } from "./companion.js";

const PING = "shepflips:companion-ping";

const readContact = () => {
  try { return new URLSearchParams(window.location.search).get("contact") || null; } catch { return null; }
};
const writeContact = (id) => {
  try {
    const p = new URLSearchParams(window.location.search);
    p.set("contact", id);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${p}`);
  } catch { /* noop */ }
};

// One person's pane. Keyed by contactId by its parent, so switching people
// starts the pane clean (the offer it picked, the editor, the tab).
function CompanionPane({ contactId, name, party, settings }) {
  const item = useMemo(() => ({ ...companionPaneItem(contactId), contactName: name || "" }), [contactId, name]);
  const dl = useLoad(draftsKey(contactId), loadDrafts(contactId), { maxAgeMs: 30000 });
  const data = dl.data;
  const targets = useMemo(() => {
    const t = rowTargets(item, data?.drafts || []);
    // The record knows whether they're an agent or a buyer; a row with no
    // draft would guess agent.
    return party ? { ...t, party } : t;
  }, [item, data, party]);
  const serverOffsetMs = data?.now ? Date.now() - Date.parse(data.now) : 0;
  const done = () => { forget(draftsKey(contactId)); dl.reload(); };
  const pane = usePane({ item, targets, onDone: done });
  const convo = { item, targets, sendsEnabled: Boolean(data?.sendsEnabled), serverOffsetMs, onDone: done, fb: pane.fb, taught: pane.coach?.taught || [], bot: pane.timeline?.bot || null };
  return (
    <section aria-label="Their offer and conversation" className="flex h-[80vh] min-h-[28rem] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="shrink-0 space-y-2 border-b border-slate-200 px-4 py-3">
        <PaneHeading item={item} targets={targets} pane={pane} fallback={name || "Their offers"} />
        <div className="flex flex-wrap items-start gap-1.5">
          <PaneActions pane={pane} item={item} targets={targets} />
        </div>
      </div>
      {/* GHL's own window already shows the conversation; the offer is what he comes here for. */}
      <PaneBody pane={pane} item={item} targets={targets} convo={convo} settings={settings} onDone={done} defaultTab="offer" />
    </section>
  );
}

export default function CompanionView({ settings = null }) {
  const [contactId, setContactId] = useState(readContact);
  const [linked, setLinked] = useState(false);     // the extension said hello
  const [finding, setFinding] = useState(false);   // a conversation id → its person
  const [error, setError] = useState("");
  const [rec, setRec] = useState(null);            // the record body's load: name and party
  const current = useRef(contactId);
  const recordRef = useRef(null);
  const locationId = getLocationId();

  const show = (id) => {
    if (!id || id === current.current) return;
    current.current = id;
    setError("");
    setRec(null);
    setContactId(id);
    writeContact(id);
    try { window.scrollTo({ top: 0 }); } catch { /* noop */ }
  };

  useEffect(() => {
    let lookup = 0;
    const onMessage = async (event) => {
      const m = readCompanionMessage(event, { win: window, contactId: current.current, locationId });
      if (!m) return;
      if (m.hello) { setLinked(true); return; }
      if (m.contactId) { lookup += 1; setFinding(false); show(m.contactId); return; }
      // Only the newest lookup wins when he clicks through threads quickly.
      const mine = ++lookup;
      setFinding(true);
      try {
        const id = await getContactByConversation(m.conversationId);
        if (mine === lookup) show(id);
      } catch (e) {
        if (mine === lookup) setError(e.status === 404 ? "GHL didn't say whose conversation that is." : e.message);
      } finally {
        if (mine === lookup) setFinding(false);
      }
    };
    window.addEventListener("message", onMessage);
    // The extension's content script may have said hello before this page
    // was listening; ask again.
    window.postMessage({ type: PING }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try { document.title = rec?.profile?.name ? `${rec.profile.name} · Companion` : "Companion"; } catch { /* noop */ }
  }, [rec]);

  // A name in the pane opens "their record": it's already on this page.
  const drawer = useMemo(() => ({
    open: (id) => {
      if (id && id !== current.current) { show(id); return; }
      recordRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    close: () => {},
  }), []);   // eslint-disable-line react-hooks/exhaustive-deps

  const name = rec?.profile?.name || rec?.investor?.name || "";
  const party = rec?.party || null;

  return (
    <ContactDrawerContext.Provider value={drawer}>
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/95 px-4 py-2 text-xs backdrop-blur">
          <span className={`h-2 w-2 shrink-0 rounded-full ${linked ? "bg-emerald-500" : "bg-slate-300"}`} aria-hidden="true" />
          <span className="text-slate-500" title={linked ? "Opening a contact or a conversation in GHL shows them here" : "The Shep Flips Companion extension isn't talking to this window. See companion-extension/README.md"}>
            {linked ? "Following GoHighLevel" : "Not following GHL yet"}
          </span>
          {finding && <span className="inline-flex items-center gap-1 text-slate-500"><Loader2 size={12} className="animate-spin" /> Finding who that is…</span>}
          {contactId && (
            <a href={ghlContactUrl(contactId)} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 font-semibold text-blue-600 hover:text-blue-700">
              Open in GHL <ExternalLink size={11} />
            </a>
          )}
        </div>
        {error && <div className="mx-4 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</div>}

        {!contactId ? (
          <div className="flex min-h-[60vh] items-center justify-center p-6 text-center text-slate-600">
            <div>
              <div className="text-base font-semibold text-slate-900">Open a contact in GoHighLevel</div>
              <p className="mt-1 text-sm">Their offers, conversation and record show up here.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4 p-3 sm:p-4">
            <CompanionPane key={contactId} contactId={contactId} name={name} party={party} settings={settings} />
            <section ref={recordRef} aria-label="Their record" className="scroll-mt-12 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              <ContactRecordBody key={contactId} contactId={contactId} inline onLoaded={setRec} />
            </section>
          </div>
        )}
      </div>
    </ContactDrawerContext.Provider>
  );
}
