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
// Our ask for their numbers, as the outbox keeps it: sent, or held and dismissed.
const takeAsk = (d, status = "sent") => ({ id: `ask${d}${status}`, contactId: "c1", status, inbound: "", intent: "take_ask", outbound: { kind: "take_ask", address: "2500 Alder St, Milton, WA 98354" },
  propertyAddress: "2500 Alder St, Milton, WA 98354", createdAt: ago(d), updatedAt: ago(d), ...(status === "sent" ? { sentAt: ago(d) } : {}) });
const claimed = (d) => ({ type: "audit_action", contactId: "c1", offerId: "h1", address: "2500 Alder St, Milton, WA 98354", at: ago(d), data: { kind: "held_ask", action: "ask_take" } });

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
  // Ryan Bowen, 2026-10-05: spaced "move in ready", and "not a fix n flip".
  t = triage({ drafts: [inbound("It's a move in ready that could use minor updates but certainly not a fix n flip.", { intent: "investor_open" })] });
  assert.equal(t.action, "retire"); assert.equal(t.status, "we_passed");
  t = triage({ drafts: [inbound("Honestly it's not a fixer", { intent: "investor_open" })] });
  assert.equal(t.action, "retire", "'not a fixer' says it isn't one");
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
  t = triage({ offer: held({ createdAt: ago(10), autoUnderwrite: { held: [THIN], finishedAt: ago(10) } }), events: [askedEv], drafts: [takeAsk(ASK_WAIT_DAYS + 1), inbound("hi", { createdAt: ago(9) })] });
  assert.equal(t.action, "retire"); assert.match(t.reason, /asked for their read a week ago/); assert.equal(t.passNote, "numbers", "and they hear we passed");
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
    autoUnderwrite: { finishedAt: "2026-10-01T19:00:00Z", held: ["not our kind of house — a townhouse (single-family only right now)"] } };
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

// 1638 119th St S (2026-10-13): the seller already had an offer working
// through short-sale approval, and that was read as a first no, the offer stayed sent, and the 7am
// card sweep moved the agent to Offer Out. A house with an offer already in
// short-sale approval is taken, the same as pending.
test("an offer already in short-sale approval means the house is gone; a short sale still for sale does not", async () => {
  const { houseGone } = await import("./held-underwrites.js");
  for (const t of [
    "There's already an offer at 340 working through the short sale process",
    "Still waiting on approval for the current offer",
    "There's an offer waiting on short sale approval",
    "They already have an accepted offer",
  ]) assert.equal(houseGone(t, "rejection"), true, t);
  for (const t of [
    "Short sale",
    "Any offer will need short sale approval",
    "Seller has a couple of offers, still taking more",
    "Short sale, bank approval can take a few months",
  ]) assert.equal(houseGone(t, "rejection"), false, t);
});

test("an ask is asked once: an answer without a number is a call, and silence or an ask that never went passes a week on, telling them", () => {
  // 3228 S 164th St (2026-10-05): asked, she described the work but gave no
  // number, and the sweep read "ask" every night against a claim that never
  // let it go — on the Desk as the machine's, with nothing coming.
  const photos = (d) => held({ createdAt: ago(d), updatedAt: ago(d), autoUnderwrite: { held: [PHOTOS], finishedAt: ago(d) } }, [PHOTOS]);
  let t = triage({ offer: photos(6), events: [claimed(4)], drafts: [takeAsk(4), inbound("Flooring throughout, kitchen cabinets and 3 baths", { createdAt: ago(3) })] });
  assert.equal(t.action, "call"); assert.deepEqual(t.needs, ["work"]); assert.match(t.reason, /without a number — worth a call/);
  // Asked three days ago and nothing back: it waits, and says when it passes.
  t = triage({ offer: photos(6), events: [claimed(3)], drafts: [takeAsk(3), inbound("hi", { createdAt: ago(5) })] });
  assert.equal(t.action, "wait"); assert.equal(t.passAt, new Date(Date.parse(ago(3)) + ASK_WAIT_DAYS * 86400000).toISOString());
  // A week of silence after it went: passed, and they hear why.
  t = triage({ offer: photos(10), events: [claimed(8)], drafts: [takeAsk(8), inbound("hi", { createdAt: ago(9) })] });
  assert.equal(t.action, "retire"); assert.equal(t.status, "we_passed"); assert.equal(t.passNote, "numbers");
  // 13536 SW 171st St: the ask was claimed, then held and dismissed, so it
  // never went. A word from them about something else doesn't make it a
  // call; a week from the claim it passes, telling them.
  t = triage({ offer: held({ createdAt: ago(6), updatedAt: ago(6), autoUnderwrite: { held: [THIN], finishedAt: ago(6) } }), events: [claimed(4)], drafts: [takeAsk(4, "dismissed"), inbound("No", { createdAt: ago(2) })] });
  assert.equal(t.action, "wait"); assert.match(t.reason, /didn't go out/);
  t = triage({ offer: held({ createdAt: ago(10), updatedAt: ago(10), autoUnderwrite: { held: [THIN], finishedAt: ago(10) } }), events: [claimed(8)], drafts: [takeAsk(8, "dismissed"), inbound("No", { createdAt: ago(6) })] });
  assert.equal(t.action, "retire"); assert.equal(t.passNote, "numbers"); assert.match(t.reason, /never went out/);
  // Before any ask, it still asks.
  assert.equal(triage({ offer: photos(2), drafts: [inbound("ok")] }).action, "ask");
});

// Matt, 2026-10-08: rural (two acres or more) is passed and the agent hears
// why — no day to wait, unlike a house that isn't single-family.
test("a rural house is passed at the next check and the agent hears it's rural", async () => {
  const { triageHeldUnderwrite, heldOnTheMachine } = await import("./held-underwrites.js");
  const now = Date.parse("2026-10-08T20:00:00Z");
  const offer = { id: "r1", address: "21800 Farm Rd SE, Maple Valley, WA 98038", contactId: "a1", status: "draft", createdAt: "2026-10-08T19:00:00Z",
    autoUnderwrite: { finishedAt: "2026-10-08T19:00:00Z", held: ["rural — it sits on 5.2 acres (we buy houses on under 2 acres)"] } };
  const t = triageHeldUnderwrite({ offer, now });
  assert.deepEqual([t.action, t.status, t.passNote], ["retire", "we_passed", "rural"]);
  assert.match(heldOnTheMachine(offer, { now }).what, /passed at the 7pm check — rural: it sits on 5\.2 acres; we buy under 2 acres/);
});

// Matt, 2026-10-13: no manufactured homes as a rule. Like rural, no day to
// wait: passed at the next check, and the agent hears we don't buy them.
test("a mobile home is passed at the next check and the agent hears we don't buy mobile homes", async () => {
  const { triageHeldUnderwrite, heldOnTheMachine } = await import("./held-underwrites.js");
  const now = Date.parse("2026-10-13T20:00:00Z");
  const offer = { id: "m1", address: "1510 Maple Lane, Kent, WA 98030", contactId: "a1", status: "draft", createdAt: "2026-10-13T19:00:00Z",
    autoUnderwrite: { finishedAt: "2026-10-13T19:00:00Z", held: ["not our kind of house — a mobile home (we don't buy mobile or manufactured homes)"] } };
  const t = triageHeldUnderwrite({ offer, now });
  assert.deepEqual([t.action, t.status, t.passNote], ["retire", "we_passed", "manufactured"]);
  assert.match(heldOnTheMachine(offer, { now }).what, /passed at the 7pm check — a mobile home; we don't buy mobile or manufactured homes/);
  // A hold written before the rule (2026-10-01 wording) passes the same way.
  const old = { ...offer, autoUnderwrite: { ...offer.autoUnderwrite, held: ["not our kind of house — a mobile home (single-family only right now)"] } };
  assert.equal(triageHeldUnderwrite({ offer: old, now }).passNote, "manufactured");
});

test("a house the agent brought is never retired because the agent's GHL card says Tier 3 — 20 brought houses died that way unpriced", () => {
  const cold = [{ stageName: "Tier 3- Cold/Keep Warm", status: "open" }];
  assert.notEqual(triage({ opportunities: cold, brought: true }).action, "retire");
  assert.equal(triage({ opportunities: [{ stageName: "Tier 1 - Hot", status: "lost" }], brought: true }).action, "retire", "a lost opportunity still closes it");
  // Their "it's turnkey" about the listing we opened with is not about the house they brought.
  const other = inbound("That one is turnkey, sorry", { propertyAddress: "" });
  assert.notEqual(triage({ drafts: [other], brought: true }).action, "retire");
  assert.equal(triage({ drafts: [other] }).action, "retire", "on our own listing, their unaddressed turnkey still closes it");
  const here = inbound("Honestly it's turnkey");
  assert.equal(triage({ drafts: [here], brought: true }).action, "retire", "said about this very house");
});

test("a house the agent said is not a project is ruled out for the machine — her latest word on it counts", async () => {
  const { agentRuledOut } = await import("./held-underwrites.js");
  const pd = (data, d = 1, address = "2027 SE Walker Park Rd, Shelton, WA 98584") => ({ type: "property_details", address, at: ago(d), data });
  const said = [pd({ condition: "great home, large sq ft, waterfront with dock", workNeeded: "none, not a project" })];
  assert.match(agentRuledOut(said, "2027 Se Walker Park Rd, Shelton, WA").why, /isn't a project/);
  assert.equal(agentRuledOut(said, "123 Other St, Shelton, WA"), null, "only that house");
  assert.equal(agentRuledOut([...said, pd({ workNeeded: "actually needs a new roof" }, 0)], "2027 Se Walker Park Rd, Shelton, WA"), null, "she changed her read");
  assert.ok(agentRuledOut([pd({ condition: "turnkey, move-in ready" })], "2027 Se Walker Park Rd"), "turnkey");
  assert.equal(agentRuledOut([pd({ condition: "needs paint and flooring", workNeeded: "cosmetic" })], "2027 Se Walker Park Rd"), null);
});

// 1425 33rd St SE, Auburn (2026-10-10): the agent called it cosmetic and said
// houses at that price "have to be turnkey" to sell — the finished house, so
// this one needs the work. Read as "turnkey", it was held, swept to
// we_passed, and the bot told him twice we'd moved on while he gave us numbers.
test("an agent saying the house has to be turnkey to sell is telling us it needs work, not that it's turnkey", async () => {
  const { agentRuledOut, saysTurnkey } = await import("./held-underwrites.js");
  const words = "Looks mostly cosmetic from the photos, and homes at that price are selling. But it has to be turn key.";
  assert.equal(saysTurnkey(words), false);
  assert.equal(saysTurnkey("houses at that price need to be turnkey to sell"), false);
  assert.equal(saysTurnkey("it must be turnkey to sell at that price"), false);
  assert.equal(saysTurnkey("This one is pretty turnkey with tenants in place."), true, "still reads a real turnkey");
  const filed = { type: "property_details", address: "2500 Alder St, Milton, WA 98354", at: ago(1),
    data: { condition: "mostly cosmetic", workNeeded: "cosmetic work; houses at that price need to be turnkey to sell" } };
  assert.equal(agentRuledOut([filed], "2500 Alder St, Milton, WA 98354"), null);
  assert.notEqual(triage({ events: [filed], drafts: [inbound(words, { intent: "deal_available" })] }).action, "retire");
});

test("an agent who called it turnkey and then gives us a rehab number has told us it needs work", async () => {
  const { agentRuledOut } = await import("./held-underwrites.js");
  const turnkey = { type: "property_details", address: "2500 Alder St, Milton, WA 98354", at: ago(2), data: { condition: "turnkey" } };
  const take = est({ arv: 490000, rehab: 75000 }, { address: "2500 Alder St, Milton, WA 98354", at: ago(1) });
  assert.ok(agentRuledOut([turnkey], "2500 Alder St, Milton, WA 98354"));
  assert.equal(agentRuledOut([turnkey, take], "2500 Alder St, Milton, WA 98354"), null);
});

test("a house the sweep passed on before we ever priced it reopens on the agent's numbers; one that isn't our kind of house does not", async () => {
  const { reopensOnTheirNumbers } = await import("./held-underwrites.js");
  const swept = (reason, over = {}) => ({ id: "p1", address: "1425 33rd St SE, Auburn, WA 98002", status: "we_passed", cashAmount: null,
    retired: { at: ago(1), by: "held-sweep", reason }, ...over });
  assert.equal(reopensOnTheirNumbers(swept('turnkey per the agent ("mostly cosmetic")')), true);
  assert.equal(reopensOnTheirNumbers(swept("held 14 days and nothing since")), true);
  assert.equal(reopensOnTheirNumbers(swept("our ask for their numbers never went out, and a week has passed")), true);
  assert.equal(reopensOnTheirNumbers(swept("we asked for their read a week ago and heard nothing")), true);
  assert.equal(reopensOnTheirNumbers(swept("not our kind of house — an apartment (single-family only right now)")), false, "a condo stays passed");
  assert.equal(reopensOnTheirNumbers(swept("on 2.5 acres — rural, our buyers don't want it")), false);
  assert.equal(reopensOnTheirNumbers(swept("they unsubscribed")), false);
  assert.equal(reopensOnTheirNumbers(swept("held 14 days and nothing since", { cashAmount: 400000 })), false, "a number of ours went out: a person re-prices");
  assert.equal(reopensOnTheirNumbers({ ...swept("held 14 days and nothing since"), retired: null }), false, "a pass a person made stays theirs");
  assert.equal(reopensOnTheirNumbers(swept("held 14 days and nothing since", { status: "passed" })), false, "their pass isn't ours to reopen");
});

test("a re-run on a house the sweep passed on isn't closed again by that old pass", () => {
  const old = { type: "offer_we_passed", address: "2500 Alder St, Milton, WA 98354", at: ago(3), data: { by: "held-sweep", reason: "turnkey per the agent" } };
  assert.notEqual(triage({ events: [old] }).reason, "we passed on this house");
  const mine = { type: "offer_we_passed", address: "2500 Alder St, Milton, WA 98354", at: ago(3), data: { by: "you" } };
  assert.equal(triage({ events: [mine] }).reason, "we passed on this house", "a pass a person made still closes it");
});

/* ---------- 2026-10-14: what we already know, and what we already said ---------- */
import { houseGone } from "./held-underwrites.js";
const MISS = "stopped early — couldn't locate 5413 Welfare Ave NE on the map";
const welfare = (over = {}) => held({ address: "5413 Welfare Ave NE", ...over }, [MISS]);
const said = (reply, over = {}) => ({ id: `r${Math.random()}`, contactId: "c1", status: "sent", party: "agent", intent: "investor_open", inbound: "Needs a refresh, new carpet and some updates",
  reply, propertyAddress: "5413 Welfare Ave NE", createdAt: ago(1), ...over });

test("a held underwrite on a house the bot passed on retires, not asks for the address", () => {
  const t = triageHeldUnderwrite({ offer: welfare(), drafts: [said("Sounds mostly cosmetic, probably not enough meat for us on that one.")], now: NOW });
  assert.equal(t.action, "retire");
  assert.equal(t.status, "we_passed");
  assert.match(t.reason, /we told them we're passing/);
  const stamped = triageHeldUnderwrite({ offer: welfare(), drafts: [said("Thanks, sounds too nice for us.", { qualify: { stage: "pass", address: "5413 Welfare Ave NE" } })], now: NOW });
  assert.equal(stamped.action, "retire");
});

test("a held underwrite we can place from the listing re-runs instead of asking", () => {
  const t = triageHeldUnderwrite({ offer: welfare(), drafts: [said("What's it actually need?", { inbound: "Needs a roof" })],
    knownAddresses: ["5413 Welfare Ave NE, Bainbridge Island, WA 98110", "99 Other St, Kent, WA 98031"], now: NOW });
  assert.equal(t.action, "rerun");
  assert.equal(t.address, "5413 Welfare Ave NE, Bainbridge Island, WA 98110");
  const unknown = triageHeldUnderwrite({ offer: welfare(), drafts: [said("What's it actually need?", { inbound: "Needs a roof" })], knownAddresses: ["99 Other St, Kent, WA 98031"], now: NOW });
  assert.equal(unknown.action, "ask", "a street we can't place is still asked about");
  assert.deepEqual(unknown.needs, ["address"]);
});

test("an offer in escrow with a backup marks the house gone", () => {
  assert.equal(houseGone("A full price offer is in escrow now, and the other one is considered the backup.", "status_check"), true);
  assert.equal(houseGone("It's in escrow with another buyer", ""), true);
  assert.equal(houseGone("We are taking backup offers", ""), true);
  assert.equal(houseGone("Great news, we're in escrow!", ""), false, "our own deal in escrow is good news");
  assert.equal(houseGone("Can you back up a sec, what's your number?", ""), false);
  assert.equal(houseGone("The seller wants out of escrow on his other house first", ""), false);
});

// 2026-10-14: houses we'd promised a number on were closed out by this sweep
// with nothing sent, and the agent was never told.
test("a house we retire after promising a number is passed with a note for the agent", () => {
  const old = held({ createdAt: ago(STALE_DAYS + 2), updatedAt: ago(STALE_DAYS + 2), autoUnderwrite: { held: [THIN], finishedAt: ago(STALE_DAYS + 2) } });
  const promised = { type: "promise_made", contactId: "c1", address: "2500 Alder St, Milton, WA 98354", at: ago(STALE_DAYS + 1), data: { what: "number", text: "I'll run it by underwriting today and get back to you with a number." } };
  let t = triage({ offer: old, events: [promised] });
  assert.equal(t.action, "retire"); assert.equal(t.status, "we_passed");
  assert.equal(t.passNote, "promised", "they hear we're out");
  assert.equal(t.promised.what, "number");
  // Nothing promised and nothing of theirs waiting: retired quietly, as before.
  t = triage({ offer: old });
  assert.equal(t.passNote, undefined);
  // A promise already kept, or about another house, isn't this one's.
  t = triage({ offer: old, events: [promised, { type: "promise_kept", contactId: "c1", at: ago(STALE_DAYS), data: { by: "dismissed" } }] });
  assert.equal(t.passNote, undefined);
  t = triage({ offer: old, events: [{ ...promised, address: "83 Olympic Dr NW, Shoreline, WA 98177" }] });
  assert.equal(t.passNote, undefined);
  // Their last word on the house, never answered, is owed an answer too.
  t = triage({ offer: old, drafts: [inbound("Did you get a chance to run it? Seller is motivated.", { status: "dismissed", createdAt: ago(STALE_DAYS + 1) })] });
  assert.equal(t.action, "retire"); assert.equal(t.passNote, "promised");
  assert.equal(t.promised.what, "answer");
  // Answered, it isn't.
  t = triage({ offer: old, drafts: [inbound("Did you get a chance to run it?", { status: "sent", createdAt: ago(STALE_DAYS + 1) })] });
  assert.equal(t.passNote, undefined);
});

test("a retire that already tells them, or one we may not text, gets no second note", () => {
  const promised = { type: "promise_made", contactId: "c1", address: "2500 Alder St, Milton, WA 98354", at: ago(1), data: { what: "number" } };
  assert.equal(triage({ events: [promised, { type: "unsubscribed", contactId: "c1", at: ago(0.5) }] }).passNote, undefined);
  assert.equal(triage({ events: [promised], contact: { tags: ["stop bot"], dnd: false } }).passNote, undefined);
  const told = inbound("Is it a fit?", { reply: "Probably not enough meat on it for us, appreciate you sending it.", sentText: "Probably not enough meat on it for us, appreciate you sending it.", createdAt: ago(0.5) });
  const t = triage({ events: [promised], drafts: [told] });
  assert.equal(t.action, "retire"); assert.equal(t.passNote, undefined, "we already told them");
});

test("'it's currently under contract' marks the house gone", () => {
  assert.equal(houseGone("It's currently under contract as a short sale.", "status_check"), true);
  assert.equal(houseGone("It's still pending", ""), true);
});

// 2026-10-15: a yes to our number is never closed out by the sweep.
test("a house they said yes on is yours, never retired by the sweep", () => {
  const yes = inbound("They're willing to accept it, all cash, close in two weeks", { createdAt: ago(STALE_DAYS + 3) });
  const old = held({ createdAt: ago(STALE_DAYS + 5), updatedAt: ago(STALE_DAYS + 5), autoUnderwrite: { held: [THIN], finishedAt: ago(STALE_DAYS + 5) } });
  const t = triage({ offer: old, drafts: [yes], now: NOW });
  assert.equal(t.action, "yours", t.reason);
  assert.match(t.reason, /said yes to our number/);
  // Without the yes the same silence retires it.
  const quiet = triage({ offer: old, drafts: [inbound("ok thanks", { createdAt: ago(STALE_DAYS + 3) })], now: NOW });
  assert.equal(quiet.action, "retire");
});

test("the sweep never retires a held draft Matt is pricing by income", () => {
  const kind = "not our kind of house — a multi-family (single-family only right now)";
  const t = triageHeldUnderwrite({ offer: held({ createdAt: ago(3), draft: { model: "income" }, autoUnderwrite: { jobId: "j1", held: [kind], finishedAt: ago(3) } }, [kind]), now: NOW });
  assert.equal(t.action, "yours");
  assert.match(t.reason, /income/);
});

/* ---------- draft only: Matt prices it (2026-10-20, no Today) ---------- */

// Matt prices the houses agents name; until he does, nothing texted the agent
// at all. The sweep asks once what the seller would take — so he has it
// when he prices — and then leaves the house to him. Since 2026-10-21 it
// never asks what it's worth done or what the work runs: we run our own
// numbers. It never passes a house he hasn't priced
// because the agent went quiet after the ask.
const DRAFT_ONLY = "ready for your comps — the app made the draft, you price it";
test("a house waiting on Matt's number asks what the seller would take once, never the agent's rehab, then waits for him", () => {
  const t = triage({ offer: held({}, [DRAFT_ONLY]), drafts: [inbound("It needs a full gut")] });
  assert.equal(t.action, "ask");
  assert.deepEqual(t.needs, ["take"]);
  const older = held({ createdAt: ago(10), updatedAt: ago(10), autoUnderwrite: { jobId: "j1", held: [DRAFT_ONLY], finishedAt: ago(10) } }, [DRAFT_ONLY]);
  const after = triage({ offer: older, drafts: [inbound("It needs a full gut", { createdAt: ago(9) }), takeAsk(8)], events: [claimed(8)] });
  assert.equal(after.action, "yours", after.reason);
  assert.match(after.reason, /your number/);
});

test("the ask for the seller's number says Matt is pricing it himself, not that our numbers are stuck", async () => {
  const { heldInPlainWords } = await import("./held-underwrites.js");
  assert.match(heldInPlainWords(DRAFT_ONLY), /Matt is running the numbers himself/);
});

// 2026-10-22 audit: a third of the sweep's closes since 10/11 ended on our
// "I'll get this in front of Matt" or on their unanswered text. On a house
// Matt prices himself that isn't the sweep's to close: it stays his (the
// card sits in Needs Matt).
test("a retired house whose agent asked us something isn't retired: it's Matt's", () => {
  const old = held({ createdAt: ago(20), updatedAt: ago(20), autoUnderwrite: { jobId: "j1", held: [DRAFT_ONLY], finishedAt: ago(20) } }, [DRAFT_ONLY]);
  const t = triage({ offer: old, drafts: [inbound("Did you get the link I sent? Seller wants 499,950", { createdAt: ago(16), status: "draft" })] });
  assert.equal(t.action, "yours", t.reason);
  assert.match(t.reason, /unanswered — yours to price or pass/);
  assert.equal(t.status, undefined);
});

test("a quiet close with nothing owed carries the pass note", () => {
  const old = held({ createdAt: ago(20), updatedAt: ago(20), autoUnderwrite: { jobId: "j1", held: [THIN], finishedAt: ago(20) } });
  const t = triage({ offer: old, drafts: [inbound("Sounds good", { createdAt: ago(18) }), { id: "r1", contactId: "c1", status: "sent", reply: "Thanks", createdAt: ago(17.9), sentAt: ago(17.9), propertyAddress: old.address }] });
  assert.equal(t.action, "retire");
  assert.equal(t.passNoteDue, "quiet");
});

test("an agent texting about another house of theirs doesn't keep this one open for good", () => {
  const old = held({ createdAt: ago(20), updatedAt: ago(20), autoUnderwrite: { jobId: "j1", held: [THIN], finishedAt: ago(20) } });
  const other = { id: "o2", contactId: "c1", address: "77 Birch Ln, Kent, WA 98030", status: "sent", cashAmount: 300000, createdAt: ago(5) };
  const chat = inbound("Any update on Birch?", { propertyAddress: "77 Birch Ln, Kent, WA 98030", createdAt: ago(1) });
  const t = triage({ offer: old, siblings: [old, other], drafts: [chat] });
  assert.equal(t.action, "retire", t.reason);
  assert.match(t.reason, /held 20 days and nothing since/);
  // The same text with no house named, and nothing else of theirs open, is about this one.
  const alone = triage({ offer: old, siblings: [old], drafts: [inbound("Any update?", { propertyAddress: "", createdAt: ago(1) })] });
  assert.notEqual(alone.action, "retire");
});
