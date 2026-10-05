import test from "node:test";
import assert from "node:assert/strict";
import { triageHeldUnderwrite, classifyHolds, latestInbound, STALE_DAYS, ASK_WAIT_DAYS } from "./held-underwrites.js";

const NOW = Date.parse("2026-09-17T02:00:00Z");   // 7pm Pacific, 2026-09-16
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const THIN = "only 1 priced comps — the price proxy needs 6 to have a top tier — not enough nearby sales to tell renovated from tired by price";
const PHOTOS = "only 5 listing photos to scan — 8 required for a scope of work";
const held = (over = {}, reasons = [THIN]) => ({
  id: "h1", contactId: "c1", contactName: "Helen Hendricks", address: "2500 Alder St, Milton, WA 98354", status: "draft", cashAmount: null,
  createdAt: ago(2), updatedAt: ago(2), autoUnderwrite: { jobId: "j1", held: reasons, finishedAt: ago(2) }, ...over,
});
const inbound = (text, over = {}) => ({ id: `d${Math.random()}`, contactId: "c1", status: "sent", party: "agent", intent: "question", inbound: text, reply: "ok", propertyAddress: "2500 Alder St, Milton, WA 98354", createdAt: ago(1), ...over });
const est = (data, over = {}) => ({ type: "agent_estimate", contactId: "c1", address: "2500 Alder St, Unit 15, Milton, WA 98354", at: ago(1), data, ...over });
const triage = (o = {}) => triageHeldUnderwrite({ offer: held(), now: NOW, ...o });

test("hold reasons sort into value / work / junk / address / structural, and only value+work are rescuable", () => {
  assert.equal(classifyHolds([THIN, PHOTOS]).rescuable, true);
  assert.equal(classifyHolds([THIN, "the photo scan flagged a possible foundation or structural problem"]).rescuable, false);
  assert.equal(classifyHolds(["dry run — nothing was published"]).junk, true);
  assert.equal(classifyHolds(['the address was read with medium confidence — "721 S Still Rd"']).address, true);
  assert.equal(classifyHolds(["stopped early — couldn't locate 34418 54th Ave S on the map"]).error, true);
  assert.equal(classifyHolds(["the subject's square footage is unknown — comps can't be size-matched"]).value, true);
  assert.equal(classifyHolds(["the scope totals $92,500, past the heavy band for under 1,000 sqft ($70,000)"]).work, true);
});

test("junk is dropped: no address, a test address, a dry run — and a draft a priced offer or a newer draft replaced", () => {
  assert.equal(triage({ offer: held({ address: "" }, ["no property address in the message"]) }).action, "drop");
  assert.equal(triage({ offer: held({ address: "1 Test St" }) }).action, "drop");
  assert.equal(triage({ offer: held({}, ["dry run — nothing was published"]) }).action, "drop");
  const t = triage({ siblings: [{ id: "o2", address: "2500 Alder St, Unit 15, Milton, WA 98354", status: "sent", cashAmount: 120000, createdAt: ago(1) }] });
  assert.equal(t.action, "drop"); assert.match(t.reason, /priced offer \(sent\)/);
  const t2 = triage({ siblings: [{ id: "h2", address: "2500 Alder St, Milton, WA", status: "draft", createdAt: ago(0.5) }] });
  assert.equal(t2.action, "drop"); assert.match(t2.reason, /newer draft/);
  // The newer one itself is not dropped for the older one.
  assert.notEqual(triageHeldUnderwrite({ offer: held({ id: "h2", createdAt: ago(0.5) }), siblings: [held()], now: NOW }).action, "drop");
});

// Today, 2026-10-02: "Underwrite held on Potter, Pasco" and "…on Wetmore
// Property" sat in Stuck as Matt's to fix. A street with no house number is
// nothing anyone can place on a map — there is no house to review.
test("'Potter, Pasco' and 'Wetmore Property' are dropped, not handed to Matt; an unplaceable '1234 Wetmore Ave' is still his", () => {
  const t = triage({ offer: held({ address: "Potter, Pasco" }, ["stopped early — couldn't locate Potter, Pasco on the map"]) });
  assert.equal(t.action, "drop");
  assert.match(t.reason, /no street number/);
  assert.equal(triage({ offer: held({ address: "Wetmore Property" }, ["stopped early — couldn't locate Wetmore Property on the map"]) }).action, "drop");
  assert.equal(triage({ offer: held({ address: "Wetmore Property" }) }).action, "drop", "whatever held it");
  const real = triage({ offer: held({ address: "1234 Wetmore Ave, Everett, WA" }, ["stopped early — couldn't locate 1234 Wetmore Ave, Everett, WA on the map"]) });
  assert.notEqual(real.action, "drop");
  // A drop deletes the draft: a park lot, a unit first, a directional before
  // the number are all real houses (review, 2026-10-02).
  for (const a of ["Lot 27, 1510 Maple Ln, Kent, WA", "Unit 5, 222 Pine St, Seattle, WA", "N 1234 Division St, Spokane, WA"]) {
    assert.notEqual(triage({ offer: held({ address: a }, ["stopped early — couldn't locate it on the map"]) }).action, "drop", a);
  }
});

test("the conversation closes it: pending/sold/no, turnkey, a passed event, an unsubscribe, a bot-off tag, a cold GHL stage", () => {
  let t = triage({ drafts: [inbound("That property is already pending now.", { intent: "rejection" })] });
  assert.equal(t.action, "retire"); assert.equal(t.status, "unavailable"); assert.match(t.reason, /pending/);
  t = triage({ drafts: [inbound("This one is pretty turnkey with tenants in place.", { intent: "deal_available" })] });
  assert.equal(t.action, "retire"); assert.equal(t.status, "we_passed"); assert.match(t.reason, /turnkey/);
  t = triage({ events: [{ type: "property_details", address: "2500 Alder St, Milton, WA", at: ago(1), data: { condition: "turnkey, completely renovated" } }] });
  assert.equal(t.status, "we_passed");
  t = triage({ events: [{ type: "offer_passed", address: "2500 Alder St, Milton, WA", at: ago(1) }] });
  assert.equal(t.status, "passed");
  assert.equal(triage({ contact: { tags: [], dnd: true } }).reason, "they unsubscribed");
  assert.match(triage({ contact: { tags: ["tier-2", "stop bot"], dnd: false } }).reason, /stop bot/);
  assert.match(triage({ opportunities: [{ stageName: "Tier 3- Cold/Keep Warm", status: "open" }] }).reason, /Tier 3/);
  assert.match(triage({ opportunities: [{ stageName: "Tier 1 - Hot", status: "lost" }] }).reason, /lost/);
  // "Pending" about the area, or "sold as is", is not this house going away.
  assert.notEqual(triage({ drafts: [inbound("I'd have to see it to throw out numbers. A few went pending in the area recently.", { intent: "other" })] }).action, "retire");
  assert.notEqual(triage({ drafts: [inbound("It is being sold as is", { intent: "question" })] }).action, "retire");
  // …but plain words about this house are, whatever the intent read.
  assert.equal(triage({ drafts: [inbound("That one is already pending", { intent: "other" })] }).status, "unavailable");
  // A "pending" about ANOTHER house does not close this one.
  t = triage({ drafts: [inbound("That one went pending", { intent: "rejection", propertyAddress: "99 Other Rd, Kent, WA" })] });
  assert.notEqual(t.action, "retire");
});

// 2617 Cottage Rd E (2026-09-15): "That property is already pending now."
// closed the held underwrite as "they passed", and a passed house gets a
// check-in every ten days — one was claimed on it 9/27. A house that went
// pending or sold is no longer available: nobody's pass, nothing chases it.
test("a house the agent says went pending or sold is no longer available, so it never gets a check-in", () => {
  for (const text of ["That property is already pending now.", "It sold last week", "That one is under contract", "They already accepted an offer", "It's off the market", "Sorry, that one is no longer available"]) {
    const t = triage({ drafts: [inbound(text, { intent: "rejection" })] });
    assert.equal(t.action, "retire", text);
    assert.equal(t.status, "unavailable", text);
    assert.match(t.reason, /^it's no longer available \(they said "/, text);
  }
  for (const text of ["Seller is not interested", "They already have multiple offers", "The seller won't sell at that"]) {
    const t = triage({ drafts: [inbound(text, { intent: "rejection" })] });
    assert.equal(t.status, "passed", `${text} — still for sale, so a check-in may bring it back`);
    assert.match(t.reason, /^they said "/);
  }
  assert.notEqual(triage({ drafts: [inbound("It is being sold as is", { intent: "rejection" })] }).status, "unavailable", "sold as is is still for sale");
});

test("stale: two weeks with no word retires it; a week after we asked with no answer retires it", () => {
  let t = triage({ offer: held({ createdAt: ago(STALE_DAYS + 1), updatedAt: ago(STALE_DAYS + 1), autoUnderwrite: { held: [THIN], finishedAt: ago(STALE_DAYS + 1) } }) });
  assert.equal(t.action, "retire"); assert.equal(t.status, "we_passed"); assert.match(t.reason, /held 15 days/);
  // …unless they wrote since.
  t = triage({ offer: held({ createdAt: ago(STALE_DAYS + 1), autoUnderwrite: { held: [THIN], finishedAt: ago(STALE_DAYS + 1) } }), drafts: [inbound("Any update?", { createdAt: ago(2) })] });
  assert.equal(t.action, "ask");
  const askedEv = { type: "audit_action", contactId: "c1", offerId: "h1", address: "2500 Alder St, Milton, WA 98354", at: ago(ASK_WAIT_DAYS + 1), data: { kind: "held_ask", action: "ask_take" } };
  t = triage({ offer: held({ createdAt: ago(10), autoUnderwrite: { held: [THIN], finishedAt: ago(10) } }), events: [askedEv], drafts: [inbound("hi", { createdAt: ago(9) })] });
  assert.equal(t.action, "retire"); assert.match(t.reason, /asked for their read a week ago/);
  // Asked three days ago: wait.
  t = triage({ offer: held({ createdAt: ago(5), autoUnderwrite: { held: [THIN], finishedAt: ago(5) } }), events: [{ ...askedEv, at: ago(3) }], drafts: [inbound("hi", { createdAt: ago(4) })] });
  assert.equal(t.action, "wait");
});

test("their numbers, given after the hold, re-run it on exactly what the holds need; given before, it's yours", () => {
  // Value hold + their ARV + a list price → re-run.
  let t = triage({ offer: held({ askingPrice: 150000 }), events: [est({ arv: 165000, rehab: 0 })] });
  assert.equal(t.action, "rerun"); assert.deepEqual(t.needs, ["value"]); assert.equal(t.askingPrice, 150000); assert.match(t.reason, /worth 165k/);
  assert.equal(t.anchorAt, ago(1));
  // No list price anywhere → can't bound their value → yours.
  t = triage({ events: [est({ arv: 165000, rehab: 0 })] });
  assert.equal(t.action, "yours"); assert.match(t.reason, /no list price/);
  // The seller's ask on the timeline is a list price.
  t = triage({ events: [est({ arv: 165000, rehab: 0 }), { type: "property_details", address: "2500 Alder St, Milton, WA", at: ago(1.5), data: { sellerAsk: 149000 } }] });
  assert.equal(t.action, "rerun"); assert.equal(t.askingPrice, 149000);
  // Work hold needs their rehab, not their value.
  t = triage({ offer: held({}, [PHOTOS]), events: [est({ arv: 165000, rehab: 0 })] });
  assert.equal(t.action, "ask"); assert.deepEqual(t.needs, ["work"]); assert.match(t.reason, /the work would run/);
  t = triage({ offer: held({}, [PHOTOS]), events: [est({ arv: 0, rehab: 8000 })] });
  assert.equal(t.action, "rerun"); assert.deepEqual(t.needs, ["work"]);
  // Numbers from BEFORE the hold were already priced against → yours.
  t = triage({ offer: held({ askingPrice: 150000 }), events: [est({ arv: 165000 }, { at: ago(3) })] });
  assert.equal(t.action, "yours"); assert.match(t.reason, /didn't clear it either/);
});

test("ask only when the thread is alive and nobody else just asked; a structural or address hold is a person's", () => {
  let t = triage({ offer: held({}, [THIN, PHOTOS]), drafts: [inbound("Sounds good", { createdAt: ago(1) })] });
  assert.equal(t.action, "ask"); assert.deepEqual(t.needs, ["value", "work"]);
  assert.match(t.reason, /worth fixed up and the work would run/);
  // Fresh hold, no inbound yet on record: still alive (they just texted the address).
  assert.equal(triage({ drafts: [] }).action, "ask");
  // Ten days old and they haven't written in ten days: not alive, yours.
  t = triage({ offer: held({ createdAt: ago(10), autoUnderwrite: { held: [THIN], finishedAt: ago(10) } }), drafts: [] });
  assert.equal(t.action, "yours"); assert.match(t.reason, /haven't written/);
  // The promise sweep asked yesterday.
  t = triage({ drafts: [inbound("ok"), { id: "p1", contactId: "c1", status: "sent", outbound: { kind: "promise_due" }, propertyAddress: "2500 Alder St, Milton, WA", createdAt: ago(1) }] });
  assert.equal(t.action, "wait"); assert.match(t.reason, /promise sweep/);
  t = triage({ offer: held({}, ["the photo scan flagged a possible foundation or structural problem"]), drafts: [inbound("ok")] });
  assert.equal(t.action, "yours");
  t = triage({ offer: held({}, ['the address was read with low confidence — "321 W St SE"']), drafts: [inbound("ok")] });
  assert.equal(t.action, "yours");
  // The map couldn't place it (818 "Popular", 2026-10-04): ask them to
  // confirm the street, once, while the thread is alive.
  t = triage({ offer: held({}, ["stopped early — couldn't locate 34418 54th Ave S on the map"]), drafts: [inbound("ok")] });
  assert.equal(t.action, "ask"); assert.deepEqual(t.needs, ["address"]);
  t = triage({ offer: held({ createdAt: ago(10), autoUnderwrite: { held: ["stopped early — couldn't locate 34418 54th Ave S on the map"], finishedAt: ago(10) } }), drafts: [] });
  assert.equal(t.action, "yours", "nobody to ask: still yours");
});

test("latestInbound reads drafts and summaries", () => {
  assert.equal(latestInbound([inbound("x", { createdAt: ago(3) })], [{ type: "text_summary", at: ago(1) }]), Date.parse(ago(1)));
  assert.equal(latestInbound([], []), null);
});

// Matt, 2026-10-04: the app should do everything else. A house that isn't
// single-family is a person's call for a day (Underwrite anyway), then it is
// passed and the agent hears we're single-family only.
test("a house that isn't single-family waits a day for you, then it's passed and they hear why", async () => {
  const { triageHeldUnderwrite, heldOnTheMachine } = await import("./held-underwrites.js");
  const now = Date.parse("2026-10-01T20:00:00Z");
  const offer = { id: "h1", address: "1510 Maple Lane, Kent, WA 98030", contactId: "a1", status: "draft", createdAt: "2026-10-01T19:00:00Z",
    autoUnderwrite: { finishedAt: "2026-10-01T19:00:00Z", held: ["not our kind of house — a mobile home (single-family only right now)"] } };
  const t = triageHeldUnderwrite({ offer, now });
  assert.equal(t.action, "wait");
  assert.match(t.reason, /passes after a day unless you underwrite it anyway/);
  const later = triageHeldUnderwrite({ offer, now: now + 25 * 3600000 });
  assert.deepEqual([later.action, later.status, later.passNote], ["retire", "we_passed", "kind"]);
  assert.match(heldOnTheMachine(offer, { now }).what, /single-family only/);
});

test("a town we've never bought in and isn't on our map is outside our area; one we've priced in is not", async () => {
  const { triageHeldUnderwrite, knownCitiesFrom, cityOf, heldOnTheMachine } = await import("./held-underwrites.js");
  assert.equal(cityOf("102 W Pearl St, Oakesdale, WA"), "oakesdale");
  const known = knownCitiesFrom([{ address: "336 SW 15th St, Chehalis, WA 98532", cashAmount: 192250, status: "sent" }, { address: "1 X St, Spokane, WA", cashAmount: 0, status: "draft" }]);
  assert.ok(known.has("chehalis") && known.has("seattle"));
  assert.equal(known.has("spokane"), false, "a draft with no number doesn't make a town ours");
  const now = Date.parse("2026-10-04T20:00:00Z");
  const oak = { id: "o", address: "102 W Pearl St, Oakesdale, WA", contactId: "a1", status: "draft", createdAt: "2026-09-29T21:34:00Z",
    autoUnderwrite: { finishedAt: "2026-09-29T21:36:00Z", held: ["\"102 W Pearl St, Oakesdale, WA\" could only be placed at the centre of its city — the comp search is centred on a guess"] } };
  const t = triageHeldUnderwrite({ offer: oak, now, knownCities: known });
  assert.deepEqual([t.action, t.status, t.passNote], ["retire", "we_passed", "area"]);
  assert.match(t.reason, /outside the area we buy in \(Oakesdale\)/);
  assert.match(heldOnTheMachine(oak, { knownCities: known, now }).what, /outside the area/);
  const che = { ...oak, address: "500 Main St, Chehalis, WA 98532" };
  assert.notEqual(triageHeldUnderwrite({ offer: che, now, knownCities: known }).status, "we_passed");
  // Review, 2026-10-04: a unit, or no comma before the state, read the city
  // wrong and passed in-area houses. The parser reads them; and a hold their
  // numbers could clear is asked about before any town is judged.
  assert.equal(cityOf("2500 Alder St, Unit 15, Milton, WA 98354"), "milton");
  assert.equal(cityOf("1234 5th Ave S, Seattle WA 98108"), "seattle");
  assert.equal(cityOf("1 Main St, Mt Vernon, WA 98273"), "mount-vernon");
  const thin = { ...oak, address: "2500 Alder St, Unit 15, Smalltown, WA 98354", autoUnderwrite: { finishedAt: "2026-10-04T19:00:00Z", held: ["only 1 priced comps — the price proxy needs 6 to have a top tier"] } };
  assert.equal(triageHeldUnderwrite({ offer: thin, now, knownCities: known }).action, "ask");
  assert.equal(heldOnTheMachine(thin, { knownCities: known, now }), null);
});

test("the reply agent's read of a house that's gone: loose on a no, strict otherwise", async () => {
  const { houseGone } = await import("./held-underwrites.js");
  assert.equal(houseGone("Thats is sold already", "rejection"), true);
  assert.equal(houseGone("That property is already pending now.", "other"), true, "names the house: whatever the intent");
  assert.equal(houseGone("Sold for 267k", "question"), false, "loose words need a no around them");
  assert.equal(houseGone("A few went pending in the area", "other"), false);
  assert.equal(houseGone("It is being sold as is", "rejection"), false);
  assert.equal(houseGone("Seller is not interested", "rejection"), false, "a no is theirs, not gone");
});
