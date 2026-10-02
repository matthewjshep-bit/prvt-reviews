import test from "node:test";
import assert from "node:assert/strict";
import {
  focusOf, focusHolds, isLiveOffer, machineTexts, spacingHolds, lightTouchDue, pickAside,
  streetOf, UNPROMPTED_AGENT_KINDS, LIGHT_TOUCH_DAYS,
} from "./agent-focus.js";
import { rungsCovered, nudgeTimes } from "./follow-up.js";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-21T16:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();

// One listing agent's book as it stood on 2026-09-21: a live
// offer on Auburn, a house they passed on in August, a house that sold (two
// rows: the August "passed" one, superseded by the September "we passed"),
// and a pending one we passed on.
const C = "agent-1";
const AUBURN = { id: "auburn", contactId: C, address: "10625 SE 304th Way, Auburn, WA 98092", cashAmount: 258250, status: "sent",
  statusAt: ago(5.7), createdAt: ago(5.7), proactive: { realmCheckAt: ago(5.7) } };
const MILITARY = { id: "military", contactId: C, address: "28422 Military Road South, Federal Way, Washington 98003", cashAmount: 165150, status: "passed",
  statusAt: ago(34), createdAt: ago(48), sends: [{ ts: ago(48) }], statusHistory: [{ status: "passed", ts: ago(34) }] };
const SHERIDAN_OLD = { id: "sheridan-aug", contactId: C, address: "4621 S Sheridan Ave, Tacoma, WA 98408", cashAmount: 126270, status: "passed",
  statusAt: ago(34), createdAt: ago(52), sends: [{ ts: ago(52) }] };
const SHERIDAN = { id: "sheridan-sep", contactId: C, address: "4621 S Sheridan Ave, Tacoma, WA 98408", cashAmount: 237499, status: "we_passed",
  statusAt: ago(6), createdAt: ago(7), sends: [{ ts: ago(7) }] };
const COTTAGE = { id: "cottage", contactId: C, address: "2617 Cottage Rd E, Sumner, WA 98390", status: "we_passed", statusAt: ago(6), createdAt: ago(6) };
const BOOK = [AUBURN, MILITARY, SHERIDAN_OLD, SHERIDAN, COTTAGE];

test("an agent's live offer is the house we text them about, whatever else is in their book", () => {
  assert.equal(focusOf(BOOK, { contactId: C })?.id, "auburn");
  assert.equal(focusOf(BOOK.filter((o) => o !== AUBURN), { contactId: C }), null, "nothing live, no focus");
  assert.equal(focusOf(BOOK, { contactId: "someone-else" }), null);
});

test("a number nobody put in front of them isn't a live conversation; a deal closing and an agreed price are", () => {
  assert.equal(isLiveOffer({ status: "new", createdAt: ago(1) }), false, "priced, never floated");
  assert.equal(isLiveOffer({ status: "new", proactive: { takeCheckAt: ago(1) } }), true, "our read went out");
  assert.equal(isLiveOffer({ status: "countered" }), true);
  assert.equal(isLiveOffer({ status: "passed", deal: { stage: "under_contract" } }), true, "a deal still closing");
  assert.equal(isLiveOffer({ status: "accepted", deal: { stage: "closed" } }), false, "a closed deal is over");
  assert.equal(isLiveOffer({ status: "draft", draft: {} }), false);

  const agreed = { id: "agreed", contactId: C, address: "9 Oak Ave, Kent, WA", status: "sent", createdAt: ago(20), sends: [{ ts: ago(20) }],
    realm: { answer: "yes", ts: ago(2) }, hot: { at: ago(2), by: "conversation", signal: "writing_up" } };
  assert.equal(focusOf([...BOOK, agreed], { contactId: C }).id, "agreed", "an agreed price beats a newer plain offer");
  const closing = { id: "closing", contactId: C, address: "3 Fir Ln, Kent, WA", status: "accepted", createdAt: ago(40), deal: { stage: "under_contract" } };
  assert.equal(focusOf([...BOOK, agreed, closing], { contactId: C }).id, "closing", "a deal closing beats everything");
});

test("a check-in on a house they passed on waits while another house is live; the live one's nudge doesn't", () => {
  const focus = focusOf(BOOK, { contactId: C });
  assert.match(focusHolds({ kind: "passed_checkin", address: MILITARY.address, focus }), /one house at a time — the live offer on 10625 SE 304th Way/);
  assert.match(focusHolds({ kind: "agent_pulse", address: "", focus }), /one house at a time/, "a 'what else is coming up' waits too");
  assert.equal(focusHolds({ kind: "offer_nudge", address: AUBURN.address, focus }), null);
  assert.equal(focusHolds({ kind: "price_drop", address: MILITARY.address, focus }), null, "the market moving is news, not a check-in");
  assert.equal(focusHolds({ kind: "passed_checkin", address: MILITARY.address, focus: null }), null, "nothing live: it goes on its own");
});

test("only the machine's own texts count toward spacing, and a queued one counts from when it sends", () => {
  const rows = [
    { status: "sent", outbound: { kind: "offer_nudge" }, sentAt: ago(2), createdAt: ago(2.1) },
    { status: "scheduled", outbound: { kind: "passed_checkin" }, sendAt: ago(-0.2), createdAt: ago(0.1) },
    { status: "sent", inbound: "any update?", reply: "Not yet", createdAt: ago(1) },                    // a reply
    { status: "sent", outbound: { kind: "check_in" }, createdAt: ago(1) },                                 // your own check-in
    { status: "dismissed", outbound: { kind: "offer_nudge" }, createdAt: ago(0.5) },                       // never went
  ];
  assert.deepEqual(machineTexts(rows).map((x) => x.kind), ["offer_nudge", "passed_checkin"]);
});

test("unprompted texts to one agent are three days apart and two a week", () => {
  const at = (d, kind = "offer_nudge") => ({ at: NOW - d * DAY, kind });
  const base = { kind: "offer_nudge", now: NOW, minHours: 72, perWeek: 2 };
  // 9/19 the audit's nudge, then the sweep on 9/21: two days later.
  assert.match(spacingHolds({ ...base, sent: [at(2)] }), /we texted them 48h ago — unprompted texts are 72h apart/);
  assert.equal(spacingHolds({ ...base, sent: [at(3.1)] }), null);
  assert.match(spacingHolds({ ...base, sent: [at(6.5), at(3.2)] }), /they've had 2 texts from us this week \(the most is 2\)/);
  assert.equal(spacingHolds({ ...base, sent: [at(8), at(3.2)] }), null, "last week's text is last week's");
  assert.match(spacingHolds({ ...base, sent: [at(-0.3)] }), /already queued/);
  assert.match(spacingHolds({ ...base, sent: [at(4)], floor: 2 }), /144h apart/, "check in less stretches the gap");
  for (const kind of ["hot_push", "realm_check", "take_check", "promise_due", "checkin_due", "price_drop", "address_chase"]) {
    assert.equal(UNPROMPTED_AGENT_KINDS.has(kind), false, kind);
    assert.equal(spacingHolds({ ...base, kind, sent: [at(0.1), at(0.2), at(0.3)] }), null, `${kind} is never held`);
  }
});

test("a passed house comes up at most once a month, and the freshest pass is the one mentioned", () => {
  assert.equal(lightTouchDue({ offers: BOOK, now: NOW }), true, "never mentioned");
  const touched = { ...MILITARY, followUps: [{ kind: "passed_checkin", step: 30, at: ago(13), aside: true }] };
  assert.equal(lightTouchDue({ offers: [AUBURN, touched], now: NOW }), false);
  assert.equal(lightTouchDue({ offers: [AUBURN, touched], now: NOW + (LIGHT_TOUCH_DAYS - 13) * DAY }), true);
  assert.equal(pickAside([{ offerId: "a", startedAt: ago(90) }, { offerId: "b", startedAt: ago(34) }]).offerId, "b");
  assert.equal(pickAside([]), null);
  assert.equal(streetOf(MILITARY.address), "28422 Military Road South");
});

test("a nudge another path already sent on the offer is that day's rung", () => {
  const started = ago(5.7);                                   // the number floated on 9/15
  const auditNudge = new Date(Date.parse(started) + 3.65 * DAY).toISOString();
  assert.deepEqual(rungsCovered({ steps: [3, 7, 14], startedAt: started, texts: [auditNudge] }), [3]);
  assert.deepEqual(rungsCovered({ steps: [3, 7, 14], startedAt: started, texts: [ago(5.6)] }), [3], "before the first rung's day it is the first rung");
  assert.deepEqual(rungsCovered({ steps: [3, 7, 14], repeatEvery: 7, startedAt: ago(30), texts: [ago(8)] }), [21], "a repeat rung");
  assert.deepEqual(rungsCovered({ steps: [3, 7, 14], startedAt: started, texts: [ago(9)] }), [], "a text before the offer isn't about it");
  const drafts = [
    { status: "sent", outbound: { kind: "offer_nudge", offerId: "auburn" }, sentAt: auditNudge },
    { status: "sent", outbound: { kind: "offer_nudge", offerId: "military" }, sentAt: ago(1) },
    { status: "dismissed", outbound: { kind: "offer_nudge", offerId: "auburn" }, createdAt: ago(1) },
  ];
  assert.deepEqual(nudgeTimes(drafts, "auburn"), [auditNudge]);
});
