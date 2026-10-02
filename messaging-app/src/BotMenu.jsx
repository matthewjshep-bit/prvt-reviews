// BotMenu.jsx — "Bot on ▾" in the work pane's header: stop, pause or resume
// the bot on this person, and how often it checks in.
//
// Matt, 2026-10-01: "stop bot on this deal", "reduce check-ins", "increase
// check-ins". A stop is the whole person and holds every sender
// (shared/bot-hold.js): nothing goes to them by itself, and their texts still
// get a draft that waits for you. A pause is a stop with an end date. Pace
// stretches or shrinks the time between our own unprompted texts — never
// closer than today's gaps. Nothing here sends anything.

import React, { useState } from "react";
import { Bot, ChevronDown, CirclePause, CirclePlay, Gauge } from "lucide-react";
import { pauseDay } from "@shared/bot-hold.js";
import { Menu } from "./ui.jsx";
import { resumeDrive, setDrivePace, stopDrive } from "./api.js";
import { botState } from "./bot-state.js";

const TONE = {
  violet: "border-violet-200 text-violet-800 hover:bg-violet-50",
  amber: "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100",
  rose: "border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100",
  slate: "border-slate-300 text-slate-600 hover:bg-slate-50",
  plain: "border-slate-300 text-slate-700 hover:bg-slate-50",
};
const PACE_DONE = { less: "Checking in half as often.", normal: "Back to the normal pace.", more: "Checking in twice as often — never closer than 40 hours apart." };

/**
 * <BotMenu contactId party name bot onChanged />
 *   bot        the timeline's `bot` (ghl-broker/contact-timeline.js), or null
 *   onChanged  after a press: the timeline, the offer and the queue are stale
 */
export default function BotMenu({ contactId, party = null, name = "", bot = null, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);   // { tone, text }
  if (!contactId) return null;
  const s = botState(bot);
  const first = String(name || "").trim().split(/\s+/)[0] || "them";
  const run = async (fn, said) => {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      const r = await fn();
      setNote({ tone: "green", text: said(r) });
      onChanged?.(r);
    } catch (e) {
      setNote({ tone: "red", text: e.message || "That didn't change." });
    } finally { setBusy(false); }
  };
  const stopped = (r) => {
    const pulled = r?.pulled?.length || 0;
    const held = r?.held?.length || 0;
    const what = [
      pulled ? `${pulled} queued text${pulled === 1 ? "" : "s"} pulled back` : "",
      held ? `${held} repl${held === 1 ? "y" : "ies"} held for you` : "",
    ].filter(Boolean).join(", ");
    const head = r?.hold?.kind === "paused" ? `Paused until ${pauseDay(r.hold.until)}` : "Stopped — nothing goes to them by itself";
    return `${head}${what ? `; ${what}` : ""}.`;
  };
  const stop = (preset = null) => run(() => stopDrive({ contactId, party, preset }), stopped);
  const resume = () => run(() => resumeDrive({ contactId, party }), () => "The bot is back on. What was held still waits for your Send.");
  const pace = (p) => run(() => setDrivePace({ contactId, pace: p, party }), () => PACE_DONE[p]);
  const current = bot?.pace || "normal";

  const items = [
    s.held
      ? { key: "resume", label: "Resume the bot", icon: <CirclePlay size={13} />, onSelect: resume, title: "Nudges and check-ins pick up again. Held drafts still wait for your Send." }
      : { key: "stop", label: `Stop the bot on ${first}`, icon: <CirclePause size={13} />, onSelect: () => stop(), title: "Nothing goes to them by itself until you resume. Their texts still get a draft, which waits for you." },
    { key: "p1w", label: "Pause 1 week", onSelect: () => stop("1w") },
    { key: "p2w", label: "Pause 2 weeks", onSelect: () => stop("2w") },
    { key: "p1m", label: "Pause 1 month", onSelect: () => stop("1m") },
    { divider: true, key: "pace" },
    { key: "less", label: "Check in less", icon: <Gauge size={13} />, selected: current === "less", onSelect: () => pace("less"), title: "Half as often: nudges, check-ins and the three-week check-in stretch to twice the gap" },
    { key: "normal", label: "Normal pace", selected: current === "normal", onSelect: () => pace("normal") },
    { key: "more", label: "Check in more", selected: current === "more", onSelect: () => pace("more"), title: "Twice as often, never closer than 40 hours apart" },
  ];
  return (
    <span className="inline-flex items-center gap-1.5">
      {note && <span className={`text-xs ${note.tone === "red" ? "text-red-700" : "text-emerald-700"}`} role="status">{note.text}</span>}
      <Menu label={`Bot: ${s.label}`} items={items} trigger={(
        <span className={`inline-flex items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-xs font-semibold transition-colors ${TONE[s.tone] || TONE.plain} ${busy ? "opacity-60" : ""}`}
          title={s.note || "Stop, pause or resume the bot on them, and how often it checks in"}>
          <Bot size={13} /> {s.label} <ChevronDown size={12} />
        </span>
      )} />
    </span>
  );
}
