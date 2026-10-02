// bot-state.js — what the work pane's Bot ▾ says, and the timeline strip's
// words for "when", from the timeline's `bot` and `next`
// (ghl-broker/contact-timeline.js). Pure, so the tests can pin it.

import { pauseDay } from "@shared/bot-hold.js";

/**
 * botState(bot) → { label, tone, held, known, note }
 *
 * The label the button wears. Things the app can't change from here (an
 * unsubscribe, a stop-bot tag in GHL, the whole bot switched off) say so in
 * `note`; Stop / Pause / pace still work underneath them.
 */
export function botState(bot) {
  if (!bot) return { label: "Bot", tone: "plain", held: false, known: false, note: "" };
  if (bot.unsubscribed) return { label: "Unsubscribed", tone: "rose", held: Boolean(bot.held), known: true, note: "They texted STOP or are on DND in GHL: nothing can be texted to them." };
  if (bot.botOffTag) return { label: "Bot off in GHL", tone: "slate", held: Boolean(bot.held), known: true, note: `Tagged "${bot.botOffTag}" in GHL, so the bot drafts nothing for them. Take the tag off in GHL to turn it back on.` };
  if (bot.held && bot.kind === "unread") return { label: "Bot: couldn't check", tone: "amber", held: true, known: false, note: "Couldn't read whether you stopped it, so nothing goes by itself until it can." };
  if (bot.held && bot.kind === "paused") return { label: `Paused until ${pauseDay(bot.until)}`, tone: "amber", held: true, known: true, note: "Nothing goes to them by itself until then. Their texts still get a draft, which waits for you." };
  if (bot.held) return { label: "Bot stopped", tone: "amber", held: true, known: true, note: "Nothing goes to them by itself until you resume. Their texts still get a draft, which waits for you." };
  if (bot.conversationEnabled === false) return { label: "Bot off", tone: "slate", held: false, known: true, note: "Conversation AI is switched off for everyone (Autopilot)." };
  const pace = bot.pace === "less" ? " · less often" : bot.pace === "more" ? " · more often" : "";
  return { label: `Bot on${pace}`, tone: "violet", held: false, known: true, note: "" };
}

const TZ = "America/Los_Angeles";
const dayKey = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });

/** "today", "tomorrow", "Thu" within the week, else "Oct 15" — Pacific. */
export function dayWord(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  if (dayKey(t) === dayKey(now)) return "today";
  if (dayKey(t) === dayKey(now + 86400000)) return "tomorrow";
  if (t > now && t - now < 6 * 86400000) return new Date(t).toLocaleDateString("en-US", { weekday: "short", timeZone: TZ });
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
}

/** "9/12" — a moment's date on the strip, Pacific. */
export const shortDate = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: TZ }) : "";
};

// What follows the strip: the next move, said plainly. Kinds with nothing
// coming read as their label ("Stopped by you", "None scheduled").
const NO_DATE = new Set(["stopped", "none", "deal", "we_passed", "superseded", "draft"]);
export function nextWords(next, now = Date.now()) {
  if (!next?.kind) return null;
  if (NO_DATE.has(next.kind) || !next.at) return { text: next.label || "", who: next.kind === "stopped" ? "you" : null, title: next.reason || "" };
  const when = dayWord(next.at, now);
  const what = String(next.label || "").replace(/\s*·.*$/, "").toLowerCase();
  return { text: `next: ${what}${when ? ` ${when}` : ""}`, who: next.who || null, title: [next.label, next.reason, next.who === "machine" ? "goes by itself" : next.who === "you" ? "waits on you" : ""].filter(Boolean).join(" — ") };
}
