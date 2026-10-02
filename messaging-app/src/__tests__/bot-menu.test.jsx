import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BotMenu from "../BotMenu.jsx";
import { botState, dayWord, nextWords } from "../bot-state.js";

// Thursday 2026-10-01, 11am Pacific.
const NOW = Date.parse("2026-10-01T18:00:00Z");

test("the Bot button says what holds them, strongest first", () => {
  expect(botState(null).label).toBe("Bot");
  expect(botState({ held: false, pace: "normal", conversationEnabled: true }).label).toBe("Bot on");
  expect(botState({ held: false, pace: "less", conversationEnabled: true }).label).toBe("Bot on · less often");
  expect(botState({ held: false, pace: "more", conversationEnabled: true }).label).toBe("Bot on · more often");
  expect(botState({ held: true, kind: "stopped" }).label).toBe("Bot stopped");
  expect(botState({ held: true, kind: "paused", until: "2026-10-15T18:00:00Z" }).label).toBe("Paused until Oct 15");
  expect(botState({ held: true, kind: "unread" }).label).toBe("Bot: couldn't check");
  expect(botState({ held: false, conversationEnabled: false }).label).toBe("Bot off");
  expect(botState({ held: false, botOffTag: "stop bot", conversationEnabled: true }).label).toBe("Bot off in GHL");
  expect(botState({ held: true, kind: "stopped", unsubscribed: true }).label).toBe("Unsubscribed");
  expect(botState({ held: true, kind: "stopped" }).note).toMatch(/their texts still get a draft/i);
});

test("the Bot menu's button carries its state for a screen reader, and renders nothing with no person", () => {
  const html = renderToStaticMarkup(<BotMenu contactId="c1" name="Dana Reyes" bot={{ held: true, kind: "paused", until: "2026-10-15T18:00:00Z" }} />);
  expect(html).toContain('aria-label="Bot: Paused until Oct 15"');
  expect(html).toContain("Paused until Oct 15");
  expect(renderToStaticMarkup(<BotMenu contactId={null} bot={null} />)).toBe("");
});

test("when the next move is, in plain words", () => {
  expect(dayWord("2026-10-01T23:00:00Z", NOW)).toBe("today");
  expect(dayWord("2026-10-02T17:00:00Z", NOW)).toBe("tomorrow");
  expect(dayWord("2026-10-05T17:00:00Z", NOW)).toBe("Mon");
  expect(dayWord("2026-10-20T17:00:00Z", NOW)).toBe("Oct 20");
  expect(nextWords({ at: "2026-10-05T16:00:00Z", kind: "offer_nudge", label: "Nudge · day 7", who: "machine" }, NOW).text).toBe("next: nudge Mon");
  expect(nextWords({ at: null, kind: "stopped", label: "Paused until Oct 15" }, NOW)).toEqual({ text: "Paused until Oct 15", who: "you", title: "" });
  expect(nextWords(null, NOW)).toBe(null);
});
