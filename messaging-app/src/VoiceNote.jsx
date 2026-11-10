// VoiceNote.jsx — what the one voice check (shared/voice.js, 2026-11-09)
// sees in a text you saved: shown beside it, never blocking it. Your own
// first texts, follow-ups, check-ins, emails, examples, rules and
// instructions go out as you wrote them; this only says what reads like a
// machine.

import React from "react";
import { voiceFlags, savedTextFlags } from "@shared/voice.js";
import { fillTemplate } from "@shared/standard-texts.js";
import { fillParagraphs } from "@shared/outreach-email.js";

// The agent a text is read for (the same one the chart shows it filled in for).
const SAMPLE = { first: "Brenda", address: "14820 SE 172nd St", street: "SE 172nd St", town: "Renton", county: "King", home: "Seattle", area: "Renton or the surrounding areas" };

/**
 * voiceNotes(text, { kind, email, saved }) → ["a dash", "I'm all ears", …]
 *
 * `kind` is the voice check's kind ("outreach_open", "day_two",
 * "agent_checkin", "checkin_email", "reply" …), which sets the length and
 * question rules. `saved`: an instruction or a rule, read for the lines it
 * teaches the bot to say.
 */
export function voiceNotes(text = "", { kind = "", email = false, saved = false } = {}) {
  const t = String(text || "");
  if (!t.trim()) return [];
  if (saved) return savedTextFlags(t);
  // The chart shows an email as "Subject: …" over its body; the body is what's read.
  const body = email ? t.replace(/^Subject:[^\n]*\n\n/, "") : t;
  const filled = (email ? fillParagraphs(body, SAMPLE) : fillTemplate(body, SAMPLE)) || body;
  return voiceFlags({ text: filled, channel: email ? "email" : "sms", kind, machine: false }).map((f) => f.key);
}

export default function VoiceNote({ text, kind = "", email = false, saved = false, className = "" }) {
  const notes = voiceNotes(text, { kind, email, saved });
  if (!notes.length) return null;
  return (
    <p className={`text-xs font-medium text-amber-700 ${className}`}>
      {saved ? "Teaches the bot to sound like a machine" : "Reads like a machine"}: {notes.join("; ")}.
      <span className="font-normal text-slate-500"> It still {saved ? "applies" : "goes"} as you wrote it.</span>
    </p>
  );
}
