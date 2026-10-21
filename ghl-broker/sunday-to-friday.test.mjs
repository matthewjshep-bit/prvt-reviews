// sunday-to-friday.test.mjs — outreach goes out Sunday to Friday, 8am to 6pm
// (2026-10-21).
//
// Matt: "let's also add in Sundays. Sunday through Friday, essentially, is
// going to be it. 8:00 am to 6:00 pm are the hours that our outreach goes
// out." Until now what the machine started waited out the whole weekend, and
// the sweep and the check-ins ran Monday to Friday.

import test from "node:test";
import assert from "node:assert/strict";
import { isWorkday, normalizeOutreachAutopilot, runsLeftInMonth } from "./outreach-sweep.js";
import { spreadAcrossDay, machineHours } from "./conversation-scheduler.js";
import { runsBetween, runDaysFrom, worksOn } from "./shared/follow-up-engine.js";
import { normalizeAgentPulse, firstCheckInAt } from "./shared/agent-pulse.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { sweepTime } from "./shared/next-follow-up.js";

// Saturday 2026-10-24 and Sunday 2026-10-25, 10am Pacific (PDT, UTC-7).
const SAT = Date.parse("2026-10-24T17:00:00Z");
const SUN = Date.parse("2026-10-25T17:00:00Z");
const MON = Date.parse("2026-10-26T17:00:00Z");
const TZ = "America/Los_Angeles";
const pacific = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

test("the sweep runs on a Sunday when its days are Sunday to Friday, and never on a Saturday", () => {
  const oa = normalizeOutreachAutopilot({ days: "sun_fri" });
  assert.equal(oa.days, "sun_fri");
  assert.equal(isWorkday(SUN, TZ, oa.days), true);
  assert.equal(isWorkday(SAT, TZ, oa.days), false);
  assert.equal(isWorkday(MON, TZ, oa.days), true);
  // Saved before 2026-10-21: the old switch still reads the same.
  assert.equal(normalizeOutreachAutopilot({}).days, "mon_fri");
  assert.equal(normalizeOutreachAutopilot({ weekdaysOnly: false }).days, "all");
  assert.equal(isWorkday(SUN, TZ, normalizeOutreachAutopilot({}).days), false);
});

test("the RentCast budget counts Sundays as run days", () => {
  const oct = Date.parse("2026-10-01T17:00:00Z");
  assert.ok(runsLeftInMonth(oct, { days: "sun_fri" }) > runsLeftInMonth(oct, { weekdaysOnly: true }));
});

test("a text the machine starts on a Saturday waits for Sunday, not Monday, on Sunday to Friday", () => {
  const auto = normalizeConversationAi({ autoSend: { weekends: "sun_to_fri", machineUntil: "18:00", quietHours: { start: "08:00", end: "21:00", timeZone: TZ } } }).autoSend;
  assert.equal(auto.weekends, "sun_to_fri");
  const hours = machineHours(auto);
  const at = spreadAcrossDay({ now: SAT, quietHours: hours, hours: 8, random: () => 0, weekends: auto.weekends });
  assert.match(pacific(at), /^Sun 08:00/);
  // "replies_only" still waits for Monday.
  const old = spreadAcrossDay({ now: SAT, quietHours: hours, hours: 8, random: () => 0, weekends: "replies_only" });
  assert.match(pacific(old), /^Mon 08:00/);
});

test("the machine's texts stop at 6pm", () => {
  const auto = normalizeConversationAi({ autoSend: { machineUntil: "18:00", quietHours: { start: "08:00", end: "21:00", timeZone: TZ } } }).autoSend;
  assert.equal(machineHours(auto).end, "18:00");
  // A Sunday spread fills the day up to six, never past it.
  const late = spreadAcrossDay({ now: SUN, quietHours: machineHours(auto), hours: 12, random: () => 0.999, weekends: "sun_to_fri" });
  assert.ok(pacific(late) <= "Sun 18:00", pacific(late));
});

test("the check-ins and the follow-up plan count Sundays when told to", () => {
  const s = normalizeAgentPulse({ days: "sun_fri" });
  assert.equal(s.days, "sun_fri");
  assert.equal(normalizeAgentPulse({}).days, "mon_fri");
  const runs = runsBetween({ hour: 12, days: "sun_fri", from: SAT - 12 * 3600000, until: MON + 12 * 3600000 });
  assert.deepEqual(runs.map((t) => pacific(t).slice(0, 3)), ["Sun", "Mon"]);
  assert.equal(runDaysFrom({ weekdaysOnly: true }), "mon_fri");
  assert.ok(worksOn(0, "sun_fri") && !worksOn(6, "sun_fri") && !worksOn(0, "mon_fri") && worksOn(6, "all"));
  // An agent who joined on a Saturday can get their first check-in on the Sunday.
  const firsts = new Set(Array.from({ length: 40 }, (_, i) => pacific(firstCheckInAt({ contactId: `c${i}`, joinedAt: new Date(SAT).toISOString(), everyDays: 7, days: "sun_fri" })).slice(0, 3)));
  assert.ok(firsts.has("Sun") && !firsts.has("Sat"), [...firsts].join(","));
});

test("a follow-up due on a Saturday is shown for Sunday on Sunday to Friday", () => {
  const at = sweepTime(SAT, 16, "sun_to_fri");
  assert.match(pacific(at), /^Sun/);
  assert.match(pacific(sweepTime(SAT, 16, "replies_only")), /^Mon/);
});
