// GhlStagePicker.jsx — the agent's GHL Acquisitions stage in the companion
// window, and the four buttons that move it (Matt, 2026-10-17: "what pipeline
// stage the person is in AND ability to edit/move stage").
//
// The stages are GHL's, in the board's order (shared/ghl-stages.js). A pick is
// Matt's move, the same as dragging the card in GHL: the broker records it
// as his, so the offers leave the card there until something new happens on
// one of their offers (POST /api/dashboard/ghl/card).

import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { CARD_STAGES, CARD_STAGE_LABEL } from "@shared/ghl-stages.js";
import { getGhlCard, setGhlCardStage } from "./api.js";
import { GHL_STAGE_CLS, ghlCardKey } from "./PaneParts.jsx";
import { forget, useLoad } from "./work-data.js";

/** What the line under the buttons says about their card before a pick. */
export function cardNote(card) {
  if (!card) return "";
  if (!card.stage) return "No card in Acquisitions yet. Pick a stage to make one.";
  if ((card.open || 0) > 1) return "They have two open cards in Acquisitions. Move the right one in GHL.";
  if (card.status === "won") return "Their card is won. Picking a stage makes a new one.";
  if (card.status && card.status !== "open") return `Their card is ${card.status} (was ${card.stage}). Picking a stage reopens it.`;
  if (!card.key || !CARD_STAGES.includes(card.key)) return `In ${card.name || card.stage}, an old stage. Pick one of these to move it.`;
  return "";
}

export default function GhlStagePicker({ contactId, party = null }) {
  const on = Boolean(contactId) && party !== "investor";
  const { data, loading, error, reload } = useLoad(on ? ghlCardKey(contactId) : null, () => getGhlCard(contactId), { maxAgeMs: 120000 });
  const [busy, setBusy] = useState(null);     // the stage being set
  const [note, setNote] = useState(null);     // { tone, text }
  if (!on) return null;
  const current = data?.status === "open" && CARD_STAGES.includes(data?.key) ? data.key : null;
  const pick = async (to) => {
    if (busy || to === current) return;
    setBusy(to); setNote(null);
    try {
      const r = await setGhlCardStage(contactId, to);
      if (r.skip) setNote({ tone: "slate", text: r.skip });
      else setNote(r.warning
        ? { tone: "amber", text: r.warning }
        : { tone: "green", text: `${r.created ? "Made a card in" : "Moved to"} ${r.to}. It stays there until something new happens on one of their offers.` });
      forget(ghlCardKey(contactId));
      reload();
    } catch (e) {
      setNote({ tone: "red", text: e.message || "It didn't move." });
    } finally { setBusy(null); }
  };
  const before = cardNote(data);
  return (
    <section aria-label="GHL pipeline stage" className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">GHL pipeline stage</span>
        {loading && !data && <Loader2 size={12} className="animate-spin text-slate-400" aria-hidden="true" />}
      </div>
      <div role="radiogroup" aria-label="Move their Acquisitions card" className="mt-2 grid grid-cols-4 gap-1 rounded-lg bg-slate-100 p-1">
        {CARD_STAGES.map((k) => {
          const on = current === k;
          return (
            <button key={k} type="button" role="radio" aria-checked={on} disabled={Boolean(busy) || (!data && !error)}
              onClick={() => pick(k)} title={on ? `In ${CARD_STAGE_LABEL[k]} now` : `Move their card to ${CARD_STAGE_LABEL[k]}`}
              className={`inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-default ${
                on ? `${GHL_STAGE_CLS[k]} shadow-sm ring-1 ring-black/5` : "text-slate-600 hover:bg-white hover:text-slate-900 disabled:opacity-60"}`}>
              {busy === k && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
              {CARD_STAGE_LABEL[k]}
            </button>
          );
        })}
      </div>
      {error && !note && <p className="mt-2 text-xs text-red-700">Couldn't read their GHL card: {error}</p>}
      {note
        ? <p className={`mt-2 text-xs ${note.tone === "red" ? "text-red-700" : note.tone === "amber" ? "text-amber-700" : note.tone === "green" ? "text-emerald-700" : "text-slate-500"}`}>{note.text}</p>
        : before && <p className="mt-2 text-xs text-slate-500">{before}</p>}
    </section>
  );
}
