// delivery-watch.test.mjs — the delivery check (delivery-watch.js).
//
// 2026-11-09 audit: no code read a send's status. 22 of our answers to
// someone who had just written never arrived since 10-01 (two on 11-09, both
// to someone asking who we were), and 160 machine texts went to 104 numbers that had
// already come back dead. The store is the JSON-file backend in a temp folder;
// GHL, Slack and the card sync are stubs. Every name, street and word below is
// made up.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-watch-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store, sentDraftsBetweenQuery, sentDraftInWindow } = await import("./store.js");
await store.init();
test.after(async () => { await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

// Monday 2026-11-09, noon Pacific.
const NOW = Date.parse("2026-11-09T20:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

/* ---------- the store's read ---------- */

const placeholders = (text) => [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

test("sent drafts between two times are listed the same by the file store and Postgres", async () => {
  const L = "loc-window";
  const rows = [
    { id: "w-old", status: "sent", sentAt: hoursAgo(30), ghlMessageId: "m-old" },
    { id: "w-a", status: "sent", sentAt: hoursAgo(20), ghlMessageId: "m-a" },
    { id: "w-b", status: "sent", sentAt: hoursAgo(5), ghlMessageId: "m-b" },
    { id: "w-young", status: "sent", sentAt: hoursAgo(1), ghlMessageId: "m-young" },
    { id: "w-noid", status: "sent", sentAt: hoursAgo(6), ghlMessageId: null },
    { id: "w-checked", status: "sent", sentAt: hoursAgo(7), ghlMessageId: "m-c", delivery: { status: "delivered", code: null, checkedAt: hoursAgo(4) } },
    { id: "w-draft", status: "draft", sentAt: null, ghlMessageId: null },
  ];
  for (const r of rows) await store.createReplyDraft({ locationId: L, contactId: `c-${r.id}`, channel: "sms", reply: "x", ...r });
  await store.createReplyDraft({ locationId: "loc-other", contactId: "c-x", status: "sent", sentAt: hoursAgo(5), ghlMessageId: "m-x", reply: "x" });

  const from = hoursAgo(26), to = hoursAgo(2);
  const listed = await store.listSentDraftsBetween(L, from, to, { limit: 100 });
  assert.deepEqual(listed.map((d) => d.id), ["w-a", "w-b"], "oldest first, only unchecked sends with a GHL id in the window");
  assert.deepEqual((await store.listSentDraftsBetween(L, from, to, { limit: 1 })).map((d) => d.id), ["w-a"], "the limit holds");

  // The file backend's filter is the Postgres WHERE, row for row.
  assert.deepEqual(rows.filter((r) => sentDraftInWindow({ ...r, locationId: L }, { locationId: L, fromIso: from, toIso: to })).map((r) => r.id), ["w-a", "w-b"]);
  const q = sentDraftsBetweenQuery({ locationId: L, fromIso: from, toIso: to, limit: 100 });
  assert.deepEqual([...new Set(placeholders(q.text))].sort((a, b) => a - b), q.params.map((_, i) => i + 1), "every value bound, nothing inlined");
  assert.deepEqual(q.params, [L, from, to, 100]);
  assert.match(q.text, /status = 'sent'/);
  assert.match(q.text, /\(doc->>'sentAt'\) >= \$2 and \(doc->>'sentAt'\) < \$3/);
  assert.match(q.text, /coalesce\(doc->>'ghlMessageId', ''\) <> ''/);
  assert.match(q.text, /coalesce\(jsonb_typeof\(doc->'delivery'\), 'null'\) = 'null'/);
  assert.match(q.text, /order by \(doc->>'sentAt'\) asc limit \$4/);
});

/* ---------- the runner ---------- */

const { runDeliveryWatch, maybeRunDeliveryWatch, _resetDeliveryWatch, CURSOR_NAME } = await import("./delivery-watch.js");
const { sendReplyDraft, startProactive, handsOffReason } = await import("./reply-agent.js");
const { runNeedsMatt } = await import("./needs-matt.js");
const { isBlockedBuyer } = await import("./shared/buyer-pulse.js");
const { normalizeDispoAutopilot } = await import("./dispo-autopilot.js");

// A fake GHL: each message's delivery by id, a contact with no DND, and every
// send and tag recorded.
function ghlStub(statuses = {}) {
  const calls = [];
  return {
    calls,
    sends: () => calls.filter((c) => c.method === "POST" && c.path === "/conversations/messages"),
    async call(p, { method = "GET", body } = {}) {
      calls.push({ method, path: p, body });
      const m = /^\/conversations\/messages\/([^/?]+)$/.exec(p);
      if (m && method === "GET") {
        const s = statuses[decodeURIComponent(m[1])];
        if (!s) throw Object.assign(new Error(`GHL GET ${p} -> 404`), { status: 404 });
        return { message: { id: m[1], ...s } };
      }
      if (p === "/conversations/messages" && method === "POST") return { messageId: `sent-${calls.length}` };
      const c = /^\/contacts\/([^/]+)$/.exec(p);
      if (c && method === "GET") return { contact: { id: c[1], firstName: "Robin", tags: [] } };
      if (p.startsWith("/conversations/search")) return { conversations: [] };
      return {};
    },
  };
}
const WATCH_ON = { conversationAi: { enabled: true, deliveryWatch: { enabled: true } } };
const sent = (locationId, contactId, over = {}) => store.createReplyDraft({
  locationId, contactId, contactName: "Robin Vale", status: "sent", channel: "sms", party: "agent", inbound: "", reply: "Hi Robin, anything new coming up on your side?",
  sentText: "Hi Robin, anything new coming up on your side?", autoSent: true, outbound: { kind: "agent_pulse" }, ...over,
});
const scheduled = (locationId, contactId, over = {}) => store.createReplyDraft({
  locationId, contactId, contactName: "Robin Vale", status: "scheduled", channel: "sms", party: "agent", inbound: "", reply: "Hi Robin, still have that fixer on Larch?",
  outbound: { kind: "agent_pulse" }, flags: [], sendAt: hoursAgo(0), ...over,
});
const CHECKIN_SAVED = { aiApiKey: "test-key", conversationAi: { enabled: true, parties: { agent: { followUp: { enabled: true } } } } };

test("an agent whose number came back unreachable twice gets no machine text, and email still goes", async () => {
  const L = "loc-unreach", C = "c-unreach";
  const first = await sent(L, C, { sentAt: hoursAgo(10), ghlMessageId: "u-1" });
  const ghl = ghlStub({ "u-1": { status: "undelivered", error: "Error 30003" }, "u-2": { status: "failed", error: "Error 30003" } });
  const one = await runDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: NOW, pace: 0 });
  assert.equal(one.failed, 1);
  assert.equal(one.dead, 0, "one 30003 is sometimes temporary");
  assert.deepEqual((await store.getReplyDraft(first.id)).delivery, { status: "undelivered", code: "30003", checkedAt: new Date(NOW).toISOString() });
  const [ev] = await store.listContactEvents(L, C, { types: ["send_failed"] });
  assert.deepEqual(ev.data, { code: "30003", class: "unreachable", kind: "agent_pulse", channel: "sms", draftId: first.id, answer: false, messageId: "u-1", auto: true });

  // A machine text after one strike still goes.
  const before = await scheduled(L, C);
  const r0 = await sendReplyDraft({ client: ghl, store, locationId: L, draftId: before.id, live: true, auto: true, readThread: async () => "" });
  assert.ok(!r0.skipped, JSON.stringify(r0));
  assert.equal(ghl.sends().length, 1);

  // The second 30003: their number is dead to the machine.
  await sent(L, C, { sentAt: new Date(NOW - 1 * 3600000).toISOString(), ghlMessageId: "u-2" });
  const two = await runDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: NOW + 2 * 3600000, pace: 0 });
  assert.equal(two.dead, 1);

  const pulse = await scheduled(L, C);
  const r = await sendReplyDraft({ client: ghl, store, locationId: L, draftId: pulse.id, live: true, auto: true, readThread: async () => "" });
  assert.equal(r.skipped, "their number came back dead");
  const d = await store.getReplyDraft(pulse.id);
  assert.equal(d.status, "dismissed");
  assert.match(d.flags.join(" "), /their number came back dead — not sent/);
  assert.equal(ghl.sends().length, 1, "nothing more went to the phone");

  // The machine doesn't start a new one either, and spends no model call finding out.
  let drafted = false;
  const p = await startProactive({ client: ghl, locationId: L, saved: CHECKIN_SAVED, store, contactId: C, kind: "checkin_due", offer: null,
    subject: { address: "12 Alder Ln", phrase: "", sourceKind: "promise" }, sendsEnabled: true, deps: { draft: async () => { drafted = true; return {}; } } });
  assert.equal(p.job, null);
  assert.match(p.skipped || "", /their number came back dead/);
  assert.equal(drafted, false);
  assert.match(handsOffReason({ deadNumber: true }), /their number came back dead/);
  assert.equal(handsOffReason({}), "", "a reply's hands-off check never sees it");

  // Email still goes.
  const email = await scheduled(L, C, { channel: "email", reply: "Hi Robin, anything new on your side?", outbound: { kind: "checkin_email", subject: "Anything new?" } });
  const re = await sendReplyDraft({ client: ghl, store, locationId: L, draftId: email.id, live: true, auto: true, readThread: async () => "" });
  assert.ok(!re.skipped, JSON.stringify(re));
  assert.equal(ghl.sends().at(-1).body.type, "Email");
  // And an answer to something they sent still goes by text.
  const answer = await scheduled(L, C, { reply: "It's Matt, I fix up houses around here.", inbound: "Do I know you?", outbound: undefined, intent: "question" });
  const ra = await sendReplyDraft({ client: ghl, store, locationId: L, draftId: answer.id, live: true, auto: true, readThread: async () => "" });
  assert.ok(!ra.skipped, JSON.stringify(ra));
  assert.equal(ghl.sends().at(-1).body.type, "SMS");
});

test("a number that came back as a landline gets no more machine texts", async () => {
  const L = "loc-landline", C = "c-landline";
  await sent(L, C, { sentAt: hoursAgo(8), ghlMessageId: "l-1" });
  const ghl = ghlStub({ "l-1": { status: "failed", error: { code: 30006, message: "Landline or unreachable carrier" } } });
  const r = await runDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: NOW, pace: 0 });
  assert.equal(r.dead, 1, "one landline is enough");
  assert.equal(r.tagged, 0, "an agent's GHL record isn't tagged");
  const pulse = await scheduled(L, C);
  const s = await sendReplyDraft({ client: ghl, store, locationId: L, draftId: pulse.id, live: true, auto: true, readThread: async () => "" });
  assert.equal(s.skipped, "their number came back dead");
  assert.equal(ghl.sends().length, 0);
  // A text going by itself that the machine didn't start (a walkthrough ask)
  // isn't binned: it waits for Matt's Send.
  const ask = await scheduled(L, C, { outbound: { kind: "showing_ask" }, reply: "Hi Robin, could we see the place on Larch Saturday?" });
  const sa = await sendReplyDraft({ client: ghl, store, locationId: L, draftId: ask.id, live: true, auto: true, readThread: async () => "" });
  assert.equal(sa.skipped, "their number came back dead");
  const held = await store.getReplyDraft(ask.id);
  assert.equal(held.status, "draft");
  assert.equal(held.autoSend.decided, false);
  assert.match(held.autoSend.reason, /their number came back dead/);
  assert.equal(ghl.sends().length, 0);
  await store.updateReplyDraft(ask.id, { ...held, status: "dismissed" });

  // Their number is fixed in GHL and Matt's text to them arrives: the machine
  // may text them again.
  await sent(L, C, { sentAt: hoursAgo(1), ghlMessageId: "l-2", autoSent: false, outbound: undefined, inbound: "Got a new phone, this is me now", intent: "small_talk" });
  const back = await runDeliveryWatch({ client: ghlStub({ "l-2": { status: "delivered" } }), locationId: L, saved: WATCH_ON, store, now: NOW + 2 * 3600000, pace: 0 });
  assert.equal(back.revived, 1);
  const again = await scheduled(L, C);
  const s2 = await sendReplyDraft({ client: ghl, store, locationId: L, draftId: again.id, live: true, auto: true, readThread: async () => "" });
  assert.ok(!s2.skipped, JSON.stringify(s2));
  assert.equal(ghl.sends().length, 1);
});

test("a question whose answer the carrier blocked shows on Needs Matt", async () => {
  const L = "loc-answer", C = "c-answer";
  const ans = await sent(L, C, { sentAt: hoursAgo(3), ghlMessageId: "a-1", outbound: undefined, inbound: "Do I know you?", intent: "question",
    reply: "Matt here, I fix up houses locally.", sentText: "Matt here, I fix up houses locally.", propertyAddress: "12 Alder Ln, Kent, WA" });
  const ghl = ghlStub({ "a-1": { status: "undelivered", error: "Error 30007" } });
  const slack = [];
  const saved = { ...WATCH_ON, slackBotToken: "xoxb-test", slack: { enabled: true, streams: { machine: true }, channels: { machine: "C0MACHINE1" } } };
  const r = await runDeliveryWatch({ client: ghl, locationId: L, saved, store, now: NOW, pace: 0, deps: { slackApi: async (token, method, body) => { slack.push(body); return { ok: true }; } } });
  assert.equal(r.answers, 1);
  assert.equal(slack.length, 1);
  assert.equal(slack[0].channel, "C0MACHINE1");
  assert.equal(slack[0].text, "Our answer to Robin on 12 Alder Ln never arrived (the carrier blocked it). Call or email.");
  assert.doesNotMatch(slack[0].text, /Vale|know you|fix up/, "first name and street only, never their words or ours");
  const [ev] = await store.listContactEvents(L, C, { types: ["send_failed"] });
  assert.equal(ev.data.answer, true);
  assert.equal(ev.data.draftId, ans.id);

  // Needs Matt reads it (with the GHL stage rule on and a stage by that name).
  const STAGES = [{ id: "s-nm", name: "Needs Matt" }, { id: "s-t1", name: "Tier 1 - Hot" }, { id: "s-t2", name: "Tier 2 - Warm" }, { id: "s-out", name: "Offer Out" }];
  const ghlStages = { listPipelines: async () => [{ id: "acq", name: "Acquisitions", stages: STAGES }], call: async () => ({}) };
  const seen = [];
  const nm = await runNeedsMatt({ store, locationId: L, client: ghlStages, ghl: ghlStages, saved: { ...saved, ghlStages: { mode: "on" } }, now: NOW,
    deps: { pipelineFor: async () => ({ shownActions: [], shownCalls: [], drafts: [] }), syncAgentCard: async (a) => { seen.push({ contactId: a.contactId, need: a.needsMatt }); return { applied: { to: "Needs Matt" } }; } } });
  assert.deepEqual(nm.byKind, { paper: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].contactId, C);
  assert.equal(seen[0].need.kind, "paper");
  assert.equal(seen[0].need.why, "Your answer on 12 Alder Ln didn't reach them (the carrier blocked it): call or email");

  // The same run again: no second Slack line today, no second event.
  const again = await runDeliveryWatch({ client: ghl, locationId: L, saved, store, now: NOW + 15 * 60000, pace: 0, deps: { slackApi: async (t, m, b) => { slack.push(b); return { ok: true }; } } });
  assert.equal(again.checked, 0, "a send with a verdict is never read twice");
  assert.equal(slack.length, 1);

  // Matt calls them: off the list.
  await store.appendContactEvents(L, C, [{ type: "call_summary", at: hoursAgo(1), source: "call", data: {} }]);
  const after = await runNeedsMatt({ store, locationId: L, client: ghlStages, ghl: ghlStages, saved: { ...saved, ghlStages: { mode: "on" } }, now: NOW + 3600000,
    deps: { pipelineFor: async () => ({ shownActions: [], shownCalls: [], drafts: [] }), syncAgentCard: async () => ({ applied: { to: "Offer Out" } }) } });
  assert.equal(after.needs, 0);
  assert.deepEqual(after.left, [{ contactId: C }]);
  // And with the delivery check off, Needs Matt never reads it.
  const off = await runNeedsMatt({ store, locationId: L, client: ghlStages, ghl: ghlStages, saved: { ghlStages: { mode: "on" } }, now: NOW,
    deps: { pipelineFor: async () => ({ shownActions: [], shownCalls: [], drafts: [] }), syncAgentCard: async () => ({}) }, dryRun: true });
  assert.equal(off.needs, 0);
});

/* ---------- deal texts ---------- */

const DEAL = (id, over = {}) => ({ id, locationId: "", contactId: "agent-x", address: "88 Quill Ct, Kent, WA 98030", cashAmount: 240000, status: "accepted",
  deal: { stage: "under_contract", investors: [], contractPrice: 240000, assignmentFee: 21000 }, ...over });
const BLAST = "Hey Robin, got 88 Quill Ct in Kent under contract. Buyer price 261k. Photos and numbers: https://deals.example.com/r/ab12";
const blastSent = (locationId, contactId, offerId, over = {}) => sent(locationId, contactId, {
  party: "investor", reply: BLAST, sentText: BLAST, intent: "blast_open", propertyAddress: "88 Quill Ct, Kent, WA 98030",
  outbound: { kind: "blast_open", offerId, address: "88 Quill Ct, Kent, WA 98030", variant: 0 }, ...over,
});

test("a deal text the carrier blocked is retried once without the link when retries are on", async () => {
  assert.equal(normalizeDispoAutopilot({}).retryBlocked, false, "retries ship off");
  assert.equal(normalizeDispoAutopilot({ retryBlocked: true }).retryBlocked, true);
  const L = "loc-retry", C = "c-buyer";
  const offer = await store.createOffer(DEAL("o-retry", { locationId: L }));
  await store.upsertInvestors(L, [{ contactId: C, name: "Robin Vale", doc: { tags: ["investor"] } }]);
  await blastSent(L, C, offer.id, { sentAt: hoursAgo(4), ghlMessageId: "b-1" });
  const ghl = ghlStub({ "b-1": { status: "undelivered", error: "Error 30007" }, "b-2": { status: "undelivered", error: "Error 30007" } });

  // Off: the failure is recorded and nothing is drafted.
  const off = await runDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: NOW, pace: 0 });
  assert.equal(off.failed, 1);
  assert.equal(off.retried, 0);
  assert.equal((await store.listReplyDrafts(L, { contactId: C, status: ["draft", "scheduled"] })).length, 0);

  // On: one retry, the same text without its link.
  const L2 = "loc-retry-on", C2 = "c-buyer2";
  const offer2 = await store.createOffer(DEAL("o-retry2", { locationId: L2 }));
  await store.upsertInvestors(L2, [{ contactId: C2, name: "Robin Vale", doc: { tags: ["investor"] } }]);
  const blast = await blastSent(L2, C2, offer2.id, { sentAt: hoursAgo(4), ghlMessageId: "b-2" });
  const on = { ...WATCH_ON, dispoAutopilot: { retryBlocked: true } };
  const r = await runDeliveryWatch({ client: ghl, locationId: L2, saved: on, store, now: NOW, pace: 0 });
  assert.equal(r.retried, 1);
  const open = await store.listReplyDrafts(L2, { contactId: C2, status: ["draft", "scheduled"] });
  assert.equal(open.length, 1);
  const retry = open[0];
  assert.equal(retry.reply, "Hey Robin, got 88 Quill Ct in Kent under contract. Buyer price 261k. Want the details?");
  assert.doesNotMatch(retry.reply, /https?:|deals\./);
  assert.equal(retry.outbound.kind, "blast_open");
  assert.equal(retry.outbound.retryOf, blast.id);
  assert.equal(retry.outbound.noLink, true, "the send-time rewrite leaves the link off too");
  assert.equal(retry.status, "draft", "sends are off on the broker here, so it waits for Matt's Send");
  assert.match(retry.autoSend.reason, /CARD_SENDS_ENABLED/);

  // Where the first one went by itself and every switch still lets it, the
  // retry is scheduled the same way, inside the machine's hours.
  const L3 = "loc-retry-live", C3 = "c-buyer3";
  const offer3 = await store.createOffer(DEAL("o-retry3", { locationId: L3 }));
  await blastSent(L3, C3, offer3.id, { sentAt: hoursAgo(4), ghlMessageId: "b-4" });
  const live = { conversationAi: { enabled: true, deliveryWatch: { enabled: true }, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } }, dispoAutopilot: { retryBlocked: true } };
  const r4 = await runDeliveryWatch({ client: ghlStub({ "b-4": { status: "undelivered", error: "Error 30007" } }), locationId: L3, saved: live, store, now: NOW, pace: 0, sendsEnabled: true, blastsEnabled: true });
  assert.equal(r4.retried, 1);
  const [sched] = await store.listReplyDrafts(L3, { contactId: C3, status: ["draft", "scheduled"] });
  assert.equal(sched.status, "scheduled");
  assert.ok(Date.parse(sched.sendAt) >= NOW, "never in the past");

  // The retry is blocked too: never a third text.
  await store.updateReplyDraft(retry.id, { ...retry, status: "sent", sentAt: new Date(NOW + 60000).toISOString(), sentText: retry.reply, ghlMessageId: "b-3", autoSent: true });
  const ghl3 = ghlStub({ "b-3": { status: "undelivered", error: "Error 30007" } });
  const r3 = await runDeliveryWatch({ client: ghl3, locationId: L2, saved: on, store, now: NOW + 3 * 3600000, pace: 0 });
  assert.equal(r3.failed, 1);
  assert.equal(r3.retried, 0);
  assert.equal((await store.listReplyDrafts(L2, { contactId: C2, status: ["draft", "scheduled"] })).length, 0);
});

test("a retried deal text is written again at send without its link, even where deal texts carry one", async () => {
  const { refreshBlastText } = await import("./blast-refresh.js");
  const invites = [];
  const fake = {
    getOffer: async () => ({ id: "o-r", locationId: "LOC", address: "88 Quill Ct, Kent, WA 98030", calc: { inputs: { arv: 380000, repairs: 60000 } },
      deal: { stage: "under_contract", contractPrice: 240000, assignmentFee: 21000 } }),
    getOfferSettings: async () => ({ dispoAutopilot: { blastLink: "always" } }),
    listDatarooms: async () => [{ id: "r1", locationId: "LOC", offerId: "o-r", status: "active", kind: "deal", snapshot: {} }],
    createDataroomInvite: async (doc) => { const row = { ...doc, id: `i${invites.length + 1}`, status: "active" }; invites.push(row); return row; },
    getDataroomInvite: async (id) => invites.find((i) => i.id === id) || null,
    updateDataroomInvite: async (id, patch) => Object.assign(invites.find((i) => i.id === id), patch),
  };
  const draft = { id: "r-1", locationId: "LOC", contactId: "c1", contactName: "Robin Vale", channel: "sms", outbound: { kind: "blast_open", offerId: "o-r", variant: 0 } };
  const first = await refreshBlastText({ store: fake, client: { call: async () => ({}) }, locationId: "LOC", draft, baseUrl: "https://deals.example.com" });
  assert.match(first.text, /https:\/\/deals\.example\.com\//, "the first deal text carries the link (blastLink always)");
  const retry = await refreshBlastText({ store: fake, client: { call: async () => ({}) }, locationId: "LOC", draft: { ...draft, outbound: { ...draft.outbound, noLink: true, retryOf: "b-1" } }, baseUrl: "https://deals.example.com" });
  assert.doesNotMatch(retry.text, /https?:|deals\./);
  assert.match(retry.text, /Buyer price 261k/);
  assert.equal(retry.invite, null, "no package link minted for it");
  assert.equal(invites.length, 1);
  // The cold deal text, when the retry was queued with one, is the wording.
  const cold = await refreshBlastText({ store: fake, client: { call: async () => ({}) }, locationId: "LOC",
    draft: { ...draft, outbound: { ...draft.outbound, noLink: true, template: "Hey {first}, I've got a house at {place}. {numbers}. Any interest in it for your next project?" } }, baseUrl: "https://deals.example.com" });
  assert.match(cold.text, /^Hey Robin, I've got a house at 88 Quill Ct/);
  assert.doesNotMatch(cold.text, /under contract|https?:/);
});

test("a deal text to a dead number marks the phone and the buyer isn't texted again", async () => {
  const L = "loc-deadbuyer", C = "c-deadbuyer";
  const offer = await store.createOffer(DEAL("o-dead", { locationId: L }));
  await store.upsertInvestors(L, [{ contactId: C, name: "Robin Vale", doc: { tags: ["investor", "kent"] } }]);
  await blastSent(L, C, offer.id, { sentAt: hoursAgo(5), ghlMessageId: "d-1" });
  const ghl = ghlStub({ "d-1": { status: "failed", error: "Error 30005" } });
  const r = await runDeliveryWatch({ client: ghl, locationId: L, saved: { ...WATCH_ON, dispoAutopilot: { retryBlocked: true } }, store, now: NOW, pace: 0 });
  assert.equal(r.dead, 1);
  assert.equal(r.tagged, 1);
  assert.equal(r.retried, 0, "a dead number is not a carrier block: nothing to retry");
  const tags = ghl.calls.filter((c) => c.method === "POST" && c.path === `/contacts/${C}/tags`);
  assert.deepEqual(tags.map((c) => c.body), [{ tags: ["phone-dead"] }]);
  assert.equal(isBlockedBuyer({ tags: ["investor", "phone-dead"] }), true, "no pulse and no deal picks them");
  // The book's own row wears it now, not at the next book sync.
  const row = await store.getInvestor(L, C);
  assert.deepEqual(row.doc.tags, ["investor", "kent", "phone-dead"]);
  assert.equal(isBlockedBuyer(row.doc), true);
  // A deal text already counting down to them is binned.
  const next = await scheduled(L, C, { party: "investor", intent: "blast_open", reply: "Hey Robin, new one in Kent.", outbound: { kind: "blast_open", offerId: offer.id, address: offer.address } });
  const s = await sendReplyDraft({ client: ghl, store, locationId: L, draftId: next.id, live: true, auto: true, readThread: async () => "" });
  assert.equal(s.skipped, "their number came back dead");
  assert.equal(ghl.sends().length, 0);
});

test("a send GHL has no record of is marked unknown once, and a blip is read again next run", async () => {
  const L = "loc-unknown";
  const gone = await sent(L, "c-gone", { sentAt: hoursAgo(6), ghlMessageId: "x-gone" });
  const blip = await sent(L, "c-blip", { sentAt: hoursAgo(5), ghlMessageId: "x-blip" });
  const ghl = {
    async call(p) {
      if (p.endsWith("x-blip")) throw Object.assign(new Error("GHL GET -> 502"), { status: 502 });
      throw Object.assign(new Error("GHL GET -> 404"), { status: 404 });
    },
  };
  const r = await runDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: NOW, pace: 0 });
  assert.equal(r.errors, 2);
  assert.equal(r.unknown, 1);
  assert.deepEqual((await store.getReplyDraft(gone.id)).delivery, { status: "unknown", code: null, checkedAt: new Date(NOW).toISOString() });
  assert.equal((await store.getReplyDraft(blip.id)).delivery, undefined);
  const next = await store.listSentDraftsBetween(L, hoursAgo(26), hoursAgo(2), { limit: 100 });
  assert.deepEqual(next.map((d) => d.id), [blip.id], "only the blip is read again");
  assert.equal((await store.listContactEvents(L, "c-gone", { types: ["send_failed"] })).length, 0, "unknown is not a failure");
});

/* ---------- the tick ---------- */

test("with the delivery check off nothing is read", async () => {
  _resetDeliveryWatch();
  const L = "loc-off";
  await sent(L, "c-off", { sentAt: hoursAgo(5), ghlMessageId: "o-1" });
  const ghl = ghlStub({ "o-1": { status: "failed", error: "Error 30006" } });
  let listed = 0;
  const spy = Object.create(store);
  spy.listSentDraftsBetween = async (...a) => { listed++; return store.listSentDraftsBetween(...a); };
  for (const saved of [{}, { conversationAi: { enabled: true } }, { conversationAi: { deliveryWatch: { enabled: false } } }]) {
    assert.equal(await maybeRunDeliveryWatch({ client: ghl, locationId: L, saved, store: spy, now: NOW }), null);
  }
  assert.equal(listed, 0);
  assert.equal(ghl.calls.length, 0);
  assert.equal(await store.getJobCursor(L, CURSOR_NAME), null, "no cursor either");
});

test("the delivery check runs once per window, retries a stale run and stops after its daily tries", async () => {
  _resetDeliveryWatch();
  const L = "loc-gate";
  await sent(L, "c-gate", { sentAt: hoursAgo(5), ghlMessageId: "g-1" });
  const ghl = ghlStub({ "g-1": { status: "delivered" } });
  const go = await maybeRunDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: NOW, pace: 0 });
  assert.equal(go.started, true);
  const r = await go.done;
  assert.equal(r.delivered, 1);
  let cur = await store.getJobCursor(L, CURSOR_NAME);
  assert.equal(cur.doc.run, null);
  assert.equal(cur.doc.tries, 1);
  assert.equal(cur.doc.last.delivered, 1);

  assert.equal(await maybeRunDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: NOW + 15 * 60000, pace: 0 }), null, "the next tick: not due");

  // A run a deploy killed: still on the cursor, never finished.
  const T = NOW + 2 * 3600000;
  await store.setJobCursor(L, CURSOR_NAME, { at: new Date(T).toISOString(), doc: { ...cur.doc, lastRun: new Date(T).toISOString(), tries: 2, run: { startedAt: new Date(T).toISOString() } } });
  assert.equal(await maybeRunDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: T + 10 * 60000, pace: 0 }), null, "a run that may still be going is left alone");
  const retried = await maybeRunDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: T + 40 * 60000, pace: 0 });
  assert.equal(retried.started, true, "stale: retried");
  await retried.done;
  cur = await store.getJobCursor(L, CURSOR_NAME);
  assert.equal(cur.doc.tries, 3);
  assert.ok(cur.doc.staleRun, "the dead run is on the record");

  // Twelve tries spent today: nothing more until tomorrow.
  await store.setJobCursor(L, CURSOR_NAME, { at: new Date(NOW).toISOString(), doc: { ...cur.doc, tries: 12, lastRun: new Date(NOW).toISOString(), run: null } });
  assert.equal(await maybeRunDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: NOW + 4 * 3600000, pace: 0 }), null);
  const tomorrow = await maybeRunDeliveryWatch({ client: ghl, locationId: L, saved: WATCH_ON, store, now: NOW + 24 * 3600000, pace: 0 });
  assert.equal(tomorrow.started, true);
  await tomorrow.done;
});
