// gatekeeper.test.mjs — who the attorney on an estate is, which estate opens
// the door, and who to reach first. Names are made up.

import test from "node:test";
import assert from "node:assert/strict";
import {
  gatekeeperKey, fromNotice, mergeGatekeeperDoc, rankGatekeepers, bestHook, hookLine, normalizeGatekeepers, splitName,
} from "./gatekeeper.js";

const NOTICE = {
  caseNo: "25-4-07311-2 SEA", county: "King", decedent: "Harold Example", pr: "Wendy Example", nonprobate: false, proSe: false,
  firstPublished: "2025-10-08", filed: "",
  attorney: { name: "Paul Q. Counsel", barNo: "40123", firm: "Counsel Estate Law PLLC", address: { line: "1201 Third Avenue, Seattle, WA 98101" }, phone: "2065550142", email: "PC@Example.test" },
};

test("an attorney is the same person on every estate: their bar number is the key", () => {
  assert.equal(gatekeeperKey({ kind: "probate_attorney", barNo: "WSBA #40123", email: "x@y.test" }), "wsba:40123");
  assert.equal(gatekeeperKey({ kind: "escrow", barNo: "40123", email: "Officer@Title.test" }), "e:officer@title.test", "a bar number only names a lawyer");
  assert.equal(gatekeeperKey({ kind: "title", phone: "(425) 555-0101" }), "p:4255550101");
  assert.equal(gatekeeperKey({ kind: "title", name: "Kim Rep", firm: "Example Title & Escrow" }), "n:kim-rep|example-title-and-escrow");
  assert.equal(gatekeeperKey({}), "");
});

test("a notice becomes the attorney and the estate that opens the door", () => {
  const { gatekeeper: g, hook: h } = fromNotice(NOTICE);
  assert.equal(g.gkKey, "wsba:40123");
  assert.equal(g.kind, "probate_attorney");
  assert.equal(g.firstName, "Paul");
  assert.equal(g.lastName, "Counsel");
  assert.equal(g.email, "pc@example.test");
  assert.deepEqual(g.counties, ["King"]);
  assert.equal(h.hookKey, "probate:king:25-4-07311-2-sea");
  assert.equal(h.gkKey, g.gkKey);
  assert.equal(h.kind, "estate");
  assert.equal(h.house, null);
});

test("an estate with no attorney is a seller, not a gatekeeper", () => {
  assert.equal(fromNotice({ ...NOTICE, proSe: true, attorney: null }), null);
  assert.equal(fromNotice({ ...NOTICE, caseNo: "" }), null, "no cause number, no way to tell the runs apart");
});

test("a second read fills blanks and keeps every county, never wiping what we had", () => {
  const m = mergeGatekeeperDoc({ email: "kept@x.test", phone: "", counties: ["King"] }, { email: "other@x.test", phone: "4255550101", counties: ["Snohomish", "King"] });
  assert.equal(m.email, "kept@x.test");
  assert.equal(m.phone, "4255550101");
  assert.deepEqual(m.counties, ["King", "Snohomish"]);
});

test("the attorney with this quarter's estates that have a house ranks first; last year's one estate ranks last", () => {
  const now = Date.parse("2025-11-01T12:00:00Z");
  const gks = [{ gkKey: "wsba:1", name: "Old" }, { gkKey: "wsba:2", name: "Busy" }, { gkKey: "wsba:3", name: "Some" }];
  const hooks = [
    { gkKey: "wsba:1", kind: "estate", firstPublished: "2024-10-01", house: { address: "1 A St" } },
    { gkKey: "wsba:2", kind: "estate", firstPublished: "2025-10-20", house: { address: "2 B St" } },
    { gkKey: "wsba:2", kind: "estate", firstPublished: "2025-09-15", house: { address: "3 C St" } },
    { gkKey: "wsba:2", kind: "estate", firstPublished: "2025-09-01" },
    { gkKey: "wsba:3", kind: "estate", firstPublished: "2025-10-25" },
  ];
  const r = rankGatekeepers(gks, hooks, { now });
  assert.deepEqual(r.map((g) => g.name), ["Busy", "Some", "Old"]);
  assert.equal(r[0].rank.recent, 3);
  assert.equal(r[0].rank.withHouse, 2);
  assert.match(r[0].rank.why, /3 estates in 90 days · 2 with a house/);
  assert.equal(r[2].rank.recent, 0);
});

test("the door opens on the newest estate with a house, else the newest estate", () => {
  const hooks = [
    { kind: "estate", decedent: "A", firstPublished: "2025-10-20" },
    { kind: "estate", decedent: "B", firstPublished: "2025-10-01", house: { address: "12 Elm St, Everett, WA 98201" } },
  ];
  assert.equal(bestHook(hooks).decedent, "B");
  assert.equal(hookLine(bestHook(hooks)), "Estate of B · 12 Elm St");
  assert.equal(bestHook([hooks[0]]).decedent, "A");
  assert.equal(bestHook([]), null);
});

test("gatekeeper settings ship off, dry and waiting for Matt", () => {
  const d = normalizeGatekeepers(undefined);
  assert.equal(d.enabled, false);
  assert.equal(d.dryRun, true);
  assert.equal(d.autoSend, false);
  assert.deepEqual(d.counties, ["King", "Snohomish", "Pierce"]);
  assert.equal(d.checkInEveryDays, 30);
  assert.equal(d.noticeEmailFrom, "");
  const s = normalizeGatekeepers({ enabled: true, dryRun: false, counties: ["King County, WA", "Kitsap"], dailyNew: 999, kinds: { escrow: false }, noticeEmailFrom: "Alerts@Notices.test" });
  assert.equal(s.enabled, true);
  assert.equal(s.dryRun, false);
  assert.deepEqual(s.counties, ["King", "Kitsap"]);
  assert.equal(s.dailyNew, 100);
  assert.deepEqual(s.kinds, { probate_attorney: true, title: true, escrow: false });
  assert.equal(s.noticeEmailFrom, "alerts@notices.test");
  assert.equal(normalizeGatekeepers({ noticeEmailFrom: "not an email" }).noticeEmailFrom, "");
});

test("a middle initial isn't a last name", () => {
  assert.deepEqual(splitName("Paul Q. Counsel"), { firstName: "Paul", lastName: "Counsel" });
  assert.deepEqual(splitName("Cher"), { firstName: "Cher", lastName: "" });
  assert.deepEqual(splitName("Sam Lawyer Jr."), { firstName: "Sam", lastName: "Lawyer" });
});
