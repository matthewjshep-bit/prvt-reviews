// coach.test.mjs — the nightly coach's runner: the gate, the run, and a person's press.
// Run: node --test coach.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coach-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const {
  runCoach, startCoach, maybeRunCoach, previewCoachProposal, applyCoachProposal, rejectCoachProposal, revertCoachProposal, fileCoachProposal, coachReport,
  _resetJobs, CURSOR_NAME, RETRY_GAP_MS, MAX_DAILY_TRIES, STALE_RUN_MS,
} = await import("./coach.js");
const { conversationConfig } = await import("./reply-agent.js");

const NOW = Date.parse("2026-09-18T03:20:00Z");   // 8:20pm Pacific, the coach's hour
const settings = (loc, over = {}) => store.saveOfferSettings(loc, { aiApiKey: "sk-test", conversationAi: { coach: { enabled: true }, rules: ["Keep it short."], ...over } });
// An edited send from this afternoon: the one signal every test here learns from.
const seedEdit = async (loc, o = {}) => {
  const d = await store.createReplyDraft({ locationId: loc, contactId: "c1", contactName: "Nate Holloway", party: "agent", intent: "price_pushback", status: "draft", inbound: "That's way too low.", reply: "I completely understand! Let me explain.", ...o });
  const ts = new Date(NOW - 4 * 3600000).toISOString();
  const sent = { ...d, status: "sent", edited: true, sentText: "Fair. It's what the numbers gave me.", sentAt: ts, updatedAt: ts, feedback: { code: "wrong_tone", note: "", at: ts } };
  await store.updateReplyDraft(d.id, sent);
  // the file store stamps createdAt at real now; pull it inside the window under test
  await store.updateReplyDraft(d.id, { ...sent, createdAt: new Date(NOW - 5 * 3600000).toISOString() });
  return d.id;
};
const proposeRule = (text = "Don't open with sympathy.") => async ({ signals }) => ({ summary: "You cut the opener.", proposals: [{ kind: "rule", text, why: "you cut the sympathetic opener", evidence: [signals.edits[0].id] }] });

test("a day nobody edited, dismissed or broke anything costs no model call", async () => {
  await settings("QUIET");
  let called = 0;
  const out = await runCoach({ locationId: "QUIET", saved: await store.getOfferSettings("QUIET"), store, now: NOW, deps: { propose: async () => { called++; return { proposals: [] }; } } });
  assert.equal(called, 0);
  assert.match(out.skipped, /nothing to learn/);
});

test("an edit becomes an open proposal; what the model says about money is dropped on the way in", async () => {
  await settings("RUN");
  const draftId = await seedEdit("RUN");
  const out = await runCoach({ locationId: "RUN", saved: await store.getOfferSettings("RUN"), store, now: NOW, deps: { propose: async ({ signals, config }) => {
    assert.equal(signals.edits[0].youSent, "Fair. It's what the numbers gave me.");
    assert.deepEqual(config.rules, ["Keep it short."]);
    return { summary: "You cut the opener.", proposals: [
      { kind: "rule", text: "Don't open with sympathy.", why: "you cut it", evidence: [draftId] },
      { kind: "rule", text: "Offer $5,000 more when they push back.", why: "x", evidence: [draftId] },
    ] };
  } } });
  assert.equal(out.kept.length, 1);
  assert.match(out.dropped[0].reason, /amount/);
  const open = await store.listCoachProposals("RUN", { status: "open" });
  assert.equal(open.length, 1);
  assert.equal(open[0].text, "Don't open with sympathy.");
  // the same lesson the next night is not proposed twice
  const again = await runCoach({ locationId: "RUN", saved: await store.getOfferSettings("RUN"), store, now: NOW + 60000, deps: { propose: proposeRule() } });
  assert.equal(again.kept.length, 0);
});

test("a dry run reports what it would propose and keeps nothing", async () => {
  await settings("DRY");
  await seedEdit("DRY");
  _resetJobs();
  const job = startCoach({ locationId: "DRY", saved: await store.getOfferSettings("DRY"), store, now: NOW, dryRun: true, deps: { propose: proposeRule() } });
  await job.done;
  assert.equal((await store.listCoachProposals("DRY")).length, 0);
  const cur = await store.getJobCursor("DRY", CURSOR_NAME);
  assert.equal(cur.doc.last.preview.length, 1);
  assert.equal(cur.doc.coachedThrough, undefined, "a dry run doesn't move the bookmark");
});

test("Apply writes the rule into the live config, Revert takes exactly it back, and a hand edit in between survives", async () => {
  await settings("APPLY");
  await seedEdit("APPLY");
  await runCoach({ locationId: "APPLY", saved: await store.getOfferSettings("APPLY"), store, now: NOW, deps: { propose: proposeRule() } });
  const [p] = await store.listCoachProposals("APPLY", { status: "open" });
  const before = conversationConfig(await store.getOfferSettings("APPLY"));

  const applied = await applyCoachProposal({ store, locationId: "APPLY", id: p.id, now: NOW });
  assert.equal(applied.status, "applied");
  const saved = await store.getOfferSettings("APPLY");
  assert.deepEqual(saved.conversationAi.rules, ["Keep it short.", "Don't open with sympathy."]);
  assert.equal(saved.aiApiKey, "sk-test", "the rest of the settings row is left alone");
  await assert.rejects(() => applyCoachProposal({ store, locationId: "APPLY", id: p.id }), /already applied/);
  await assert.rejects(() => applyCoachProposal({ store, locationId: "OTHER", id: p.id }), /no such proposal/);

  await store.saveOfferSettings("APPLY", { ...saved, conversationAi: { ...saved.conversationAi, rules: [...saved.conversationAi.rules, "Mine."] } });
  const reverted = await revertCoachProposal({ store, locationId: "APPLY", id: p.id, now: NOW });
  assert.equal(reverted.status, "reverted");
  const after = conversationConfig(await store.getOfferSettings("APPLY"));
  assert.deepEqual(after.rules, ["Keep it short.", "Mine."]);
  assert.deepEqual({ ...after, rules: before.rules }, before, "nothing else moved");
});

test("the preview drafts the same message with and without the proposal — cold, never from the live thread — and changes nothing", async () => {
  await settings("PRE");
  await seedEdit("PRE");
  await runCoach({ locationId: "PRE", saved: await store.getOfferSettings("PRE"), store, now: NOW, deps: { propose: proposeRule() } });
  const [p] = await store.listCoachProposals("PRE", { status: "open" });
  const asked = [];
  const out = await previewCoachProposal({ store, locationId: "PRE", id: p.id, deps: { preview: async (a) => {
    asked.push(a);
    return { draft: { reply: a.saved.conversationAi.rules.includes("Don't open with sympathy.") ? "Fair." : "I completely understand!" } };
  } } });
  assert.equal(out.rows.length, 1);
  assert.deepEqual([out.rows[0].before, out.rows[0].after, out.rows[0].youSent], ["I completely understand!", "Fair.", "Fair. It's what the numbers gave me."]);
  assert.ok(asked.every((a) => a.contactId === "" && a.fakeParty === "agent" && a.message === "That's way too low."), "the thread that now holds your answer is never read");
  assert.deepEqual(conversationConfig(await store.getOfferSettings("PRE")).rules, ["Keep it short."], "nothing was saved");
  assert.equal((await store.getCoachProposal(p.id)).status, "open");
});

test("a rejected proposal stays rejected, and can't then be applied", async () => {
  await settings("NO");
  await seedEdit("NO");
  await runCoach({ locationId: "NO", saved: await store.getOfferSettings("NO"), store, now: NOW, deps: { propose: proposeRule() } });
  const [p] = await store.listCoachProposals("NO", { status: "open" });
  assert.equal((await rejectCoachProposal({ store, locationId: "NO", id: p.id })).status, "rejected");
  await assert.rejects(() => applyCoachProposal({ store, locationId: "NO", id: p.id }), /already rejected/);
  assert.deepEqual(conversationConfig(await store.getOfferSettings("NO")).rules, ["Keep it short."]);
});

test("once a night in its hour, off by default, the cursor written before the run, a failed run retried and then left", async () => {
  _resetJobs();
  await store.saveOfferSettings("OFF", { aiApiKey: "sk-test" });
  assert.equal(await maybeRunCoach({ locationId: "OFF", saved: await store.getOfferSettings("OFF"), store, now: NOW, deps: { propose: proposeRule() } }), false, "off until switched on");

  await settings("GATE");
  await seedEdit("GATE");
  const saved = await store.getOfferSettings("GATE");
  const boom = { propose: async () => { throw new Error("overloaded"); } };
  assert.equal(await maybeRunCoach({ locationId: "GATE", saved, store, now: NOW - 5 * 3600000, deps: boom }), false, "3pm is not the hour");
  assert.equal(await maybeRunCoach({ locationId: "GATE", saved: { ...saved, aiApiKey: "" }, store, now: NOW }), false, "no key, no run");
  assert.equal(await maybeRunCoach({ locationId: "GATE", saved, store, now: NOW, deps: boom }), true);
  assert.ok((await store.getJobCursor("GATE", CURSOR_NAME)).doc.lastDaily, "stamped before the model answered");
  await (await import("./coach.js")).getJob("GATE").done;
  const failed = await store.getJobCursor("GATE", CURSOR_NAME);
  assert.equal(failed.doc.failed, true);
  assert.match(failed.doc.error, /overloaded/);
  assert.deepEqual((await store.listAppErrorsSince("GATE", new Date(0).toISOString())).map((e) => [e.area, e.message]), [["coach", "overloaded"]], "and the failure is kept where a person can see it");

  assert.equal(await maybeRunCoach({ locationId: "GATE", saved, store, now: NOW + RETRY_GAP_MS - 1000, deps: boom }), false, "not yet");
  let t = NOW;
  for (let i = 1; i < MAX_DAILY_TRIES; i++) {
    t += RETRY_GAP_MS + 1000;
    assert.equal(await maybeRunCoach({ locationId: "GATE", saved, store, now: t, deps: boom }), true, `retry ${i}`);
    await (await import("./coach.js")).getJob("GATE").done;
  }
  assert.equal(await maybeRunCoach({ locationId: "GATE", saved, store, now: t + RETRY_GAP_MS + 1000, deps: boom }), false, "out of tries tonight");
});

test("a run that vanished in a redeploy is picked up again; one that finished is not run twice", async () => {
  _resetJobs();
  await settings("STALE");
  await seedEdit("STALE");
  const saved = await store.getOfferSettings("STALE");
  await store.setJobCursor("STALE", CURSOR_NAME, { at: new Date(NOW).toISOString(), doc: { tries: 1, lastDaily: new Date(NOW).toISOString(), run: { id: "co-x", startedAt: new Date(NOW).toISOString() } } });
  assert.equal(await maybeRunCoach({ locationId: "STALE", saved, store, now: NOW + STALE_RUN_MS - 1000, deps: { propose: proposeRule() } }), false, "may still be going");
  assert.equal(await maybeRunCoach({ locationId: "STALE", saved, store, now: NOW + STALE_RUN_MS + RETRY_GAP_MS, deps: { propose: proposeRule() } }), true);
  await (await import("./coach.js")).getJob("STALE").done;
  assert.equal(await maybeRunCoach({ locationId: "STALE", saved, store, now: NOW + STALE_RUN_MS + 2 * RETRY_GAP_MS + 5000, deps: { propose: proposeRule() } }), false);
  assert.equal((await store.listCoachProposals("STALE")).length, 1);
});

test("a code gap is filed to GitHub scrubbed — first name only — and never without a repo and token", async () => {
  await settings("GH");
  const draftId = await seedEdit("GH");
  await runCoach({ locationId: "GH", saved: await store.getOfferSettings("GH"), store, now: NOW, deps: { propose: async () => ({ proposals: [
    { kind: "code_gap", title: "Agent called by our own first name", why: "Nate Holloway was signed off as Matt", suspectedArea: "callsThemOurName", suggestedTest: "a reply that uses our name as theirs is blocked", evidence: [draftId] },
  ] }) } });
  const [p] = await store.listCoachProposals("GH", { status: "open" });
  await assert.rejects(() => applyCoachProposal({ store, locationId: "GH", id: p.id }), /filed, not applied/);
  await assert.rejects(() => fileCoachProposal({ store, locationId: "GH", id: p.id }), /repo and an issues-only token/);

  await store.saveOfferSettings("GH", { ...(await store.getOfferSettings("GH")), githubRepo: "someone/repo", githubToken: "ghp_x" });
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push([url, opts]); return { ok: true, json: async () => ({ number: 7, html_url: "https://github.com/someone/repo/issues/7" }) }; };
  const filed = await fileCoachProposal({ store, locationId: "GH", id: p.id, fetchImpl });
  assert.equal(filed.status, "filed");
  assert.equal(filed.issue.number, 7);
  assert.equal(calls[0][0], "https://api.github.com/repos/someone/repo/issues");
  const sent = JSON.parse(calls[0][1].body);
  assert.doesNotMatch(sent.body, /Holloway/);
  assert.match(sent.body, /Nate was signed off/);
  assert.deepEqual(sent.labels, ["coach"]);
});

test("the report Today reads: the open ones, the applied ones with a scorecard, and whether filing is wired", async () => {
  const report = await coachReport({ store, locationId: "APPLY", saved: await store.getOfferSettings("APPLY"), now: NOW });
  assert.equal(report.enabled, true);
  assert.equal(report.hour, 20);
  assert.equal(report.canFile, false);
  assert.equal(report.open.length, 0);
  assert.equal(report.settled[0].status, "reverted");
  const gh = await coachReport({ store, locationId: "GH", saved: await store.getOfferSettings("GH"), now: NOW });
  assert.equal(gh.canFile, true);
});
