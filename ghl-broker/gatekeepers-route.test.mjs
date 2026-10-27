// gatekeepers-route.test.mjs — /api/gatekeepers: probate notices in, the
// attorneys on them ranked, title and escrow added by hand, and an import
// to GHL that is dry by default and never fires an agent workflow. Every
// name below is made up.
//
//   node --test gatekeepers-route.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeepers-route-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;
delete process.env.OUTREACH_IMPORTS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createGatekeepersRouter } = await import("./routes/gatekeepers.js");

const LOC = "loc-gatekeepers";
// GHL, stubbed: who is already a contact, and every call that would write.
const ghl = { existing: new Map(), writes: [] };
const client = {
  async call(p, opts = {}) {
    if (p.startsWith("/contacts/search/duplicate")) {
      const q = new URL(`http://x${p}`).searchParams;
      const id = ghl.existing.get(q.get("email") || q.get("number"));
      return id ? { contact: { id } } : {};
    }
    ghl.writes.push({ path: p, method: opts.method || "GET", body: opts.body });
    if (p === "/contacts/" && opts.method === "POST") return { contact: { id: `c-${ghl.writes.length}` } };
    if (/^\/contacts\/[^/]+$/.test(p) && !opts.method) return { contact: { id: p.split("/")[2], email: "kept@x.test", tags: ghl.tagsOf?.[p.split("/")[2]] || [] } };
    return {};
  },
};
// The county owner lookup, stubbed: the Snohomish estate has a house.
const houseLookups = { Snohomish: async (h) => (h.decedent === "Margaret Anne Sample" ? { address: "2930 Example Ave, Everett, WA 98201", parcelId: "p1", source: "test" } : { matches: 0, reason: "no house in the owner's name" }) };

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/gatekeepers", createGatekeepersRouter({ resolveLocation: () => ({ locationId: LOC, client }), deps: { houseLookups } }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}/api/gatekeepers`;
await store.init();
test.after(() => { server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

const post = async (p, body) => (await fetch(`${B}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

const BODY = "The personal representative named below has been appointed as personal representative of this estate. Any person having a claim against the decedent must present the claim in the manner as provided in RCW 11.40.070.";
const notice = ({ no, county, decedent, pr, atty, bar, firm, street, city, phone, published }) =>
  `PROBATE NOTICE TO CREDITORS NO. ${no} SUPERIOR COURT OF WASHINGTON FOR ${county.toUpperCase()} COUNTY In the Matter of the Estate of ${decedent.toUpperCase()}, Deceased. ${BODY} Date of First Publication: ${published} Personal Representative: ${pr} Attorney for the Personal Representative: ${atty}, WSBA #${bar} Address for Mailing or Service: ${firm}, ${street}, ${city}, WA 98201 ${phone}`;

const today = new Date();
const daysAgo = (n) => new Date(today.getTime() - n * 86400000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const PASTE = [
  notice({ no: "25-4-02044-31", county: "Snohomish", decedent: "Margaret Anne Sample", pr: "Robert Sample", atty: "Linda Advocate", bar: "28877", firm: "Advocate Law PLLC", street: "100 Main St", city: "Everett", phone: "(425) 555-0199", published: daysAgo(10) }),
  notice({ no: "25-4-02051-31", county: "Snohomish", decedent: "Frank Other", pr: "Jo Other", atty: "Linda Advocate", bar: "28877", firm: "Advocate Law PLLC", street: "100 Main St", city: "Everett", phone: "(425) 555-0199", published: daysAgo(20) }),
  // The same estate's second weekly run: one estate, not two.
  notice({ no: "25-4-02051-31", county: "Snohomish", decedent: "Frank Other", pr: "Jo Other", atty: "Linda Advocate", bar: "28877", firm: "Advocate Law PLLC", street: "100 Main St", city: "Everett", phone: "(425) 555-0199", published: daysAgo(13) }),
  notice({ no: "25-4-07311-2 SEA", county: "King", decedent: "Harold Example", pr: "Wendy Example", atty: "Paul Counsel", bar: "40123", firm: "Counsel Estate Law PLLC", street: "1201 Third Ave", city: "Seattle", phone: "(206) 555-0142", published: daysAgo(40) }),
  // A county we don't work.
  notice({ no: "25-4-00100-0", county: "Spokane", decedent: "Far Away", pr: "Near By", atty: "East Lawyer", bar: "11111", firm: "Spokane Law PLLC", street: "1 Riverside Ave", city: "Spokane", phone: "(509) 555-0100", published: daysAgo(5) }),
].join("\n\n");

test("pasted probate notices become the attorneys on them, ranked by this quarter's estates with a house", async () => {
  const r = await post("/notices", { text: PASTE });
  assert.equal(r.notices, 4, "the repeat run of one estate counts once");
  assert.equal(r.outOfArea, 1);
  assert.equal(r.attorneys.created, 2);
  assert.equal(r.estates.created, 3);
  assert.equal(r.housesFound, 1);
  assert.equal(r.houseMisses["no owner lookup for King"], 1);

  const list = await (await fetch(B)).json();
  assert.equal(list.importsLive, false);
  assert.deepEqual(list.gatekeepers.map((g) => g.gkKey), ["wsba:28877", "wsba:40123"]);
  const top = list.gatekeepers[0];
  assert.equal(top.kind, "probate_attorney");
  assert.equal(top.firm, "Advocate Law PLLC");
  assert.equal(top.phone, "4255550199");
  assert.equal(top.rank.recent, 2);
  assert.equal(top.rank.withHouse, 1);
  assert.equal(top.hookLine, "Estate of Margaret Anne Sample · 2930 Example Ave", "opens on the estate with a house");
  assert.equal(top.hooks, 2);

  // Pasting the same notices again changes nothing and doesn't ask the county again.
  const again = await post("/notices", { text: PASTE });
  assert.equal(again.attorneys.created, 0);
  assert.equal(again.estates.created, 0);
  assert.equal(again.housesFound, 0);
  assert.deepEqual(again.houseMisses, {});
});

test("a title officer added by hand joins the list with the closing we shared", async () => {
  const r = await post("/", { kind: "title", name: "Kim Rep", firm: "Example Title", phone: "425-555-0101", email: "kim@exampletitle.test", closingAddress: "12 Elm St, Kent, WA" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.saved, ["e:kim@exampletitle.test"]);
  const bad = await post("/", { kind: "escrow" });
  assert.equal(bad.saved.length, 0);
  const list = await (await fetch(`${B}?kind=title`)).json();
  assert.equal(list.gatekeepers.length, 1);
  assert.equal(list.gatekeepers[0].rank.closings, 1);
  assert.match(list.gatekeepers[0].hookLine, /12 Elm St/);
});

test("the import is dry unless asked live AND imports are switched on, and a dry run writes nothing to GHL", async () => {
  ghl.writes.length = 0;
  ghl.existing.set("+12065550142", "existing-paul");
  const r = await post("/import", { gkKeys: ["wsba:28877", "wsba:40123"], dryRun: false });
  assert.equal(r.dryRun, true, "OUTREACH_IMPORTS_ENABLED is off");
  assert.equal(r.results[0].wouldCreate, true);
  assert.equal(r.results[1].wouldUpdate, true);
  assert.deepEqual(r.results[0].tags, ["gatekeeper", "gatekeeper-probate-attorney", "gatekeeper-src-probate-notice"]);
  assert.equal(ghl.writes.filter((w) => w.method !== "GET").length, 0, "reads only");
});

test("a live import tags gatekeepers apart from agents, fills blanks only, and marks them imported", async () => {
  process.env.OUTREACH_IMPORTS_ENABLED = "true";
  try {
    ghl.writes.length = 0;
    const r = await post("/import", { gkKeys: ["wsba:28877", "wsba:40123"], dryRun: false });
    assert.equal(r.dryRun, false);
    assert.equal(r.created, 1);
    assert.equal(r.updated, 1);
    const create = ghl.writes.find((w) => w.path === "/contacts/" && w.method === "POST");
    assert.equal(create.body.source, "gatekeeper");
    assert.equal(create.body.companyName, "Advocate Law PLLC");
    assert.equal(create.body.phone, "+14255550199");
    const tagWrites = ghl.writes.filter((w) => w.path.endsWith("/tags"));
    assert.equal(tagWrites.length, 2);
    for (const w of tagWrites) {
      assert.ok(w.body.tags.includes("gatekeeper"));
      assert.ok(!w.body.tags.some((t) => t.startsWith("agent-outreach")), "no agent workflow trigger");
    }
    const put = ghl.writes.find((w) => w.path === "/contacts/existing-paul" && w.method === "PUT");
    assert.equal(put.body.email, undefined, "an email they have is kept");
    const row = await store.getGatekeeper(LOC, "wsba:28877");
    assert.equal(row.status, "imported");
    assert.ok(row.contactId);
    const profile = await store.getContactProfile(LOC, row.contactId);
    assert.equal(profile.party, "gatekeeper");

    const twice = await post("/import", { gkKeys: ["wsba:28877"], dryRun: false });
    assert.equal(twice.results[0].alreadyImported, true);
  } finally {
    delete process.env.OUTREACH_IMPORTS_ENABLED;
  }
});

test("someone GHL already has as an agent or a buyer is never tagged a gatekeeper — it would take them off the bot", async () => {
  process.env.OUTREACH_IMPORTS_ENABLED = "true";
  try {
    await post("/", { kind: "escrow", name: "Ann Agent", firm: "Some Escrow", email: "ann@agent.test" });
    ghl.existing.set("ann@agent.test", "agent-ann");
    ghl.tagsOf = { "agent-ann": ["agent", "agent-outreach"] };
    ghl.writes.length = 0;
    const r = await post("/import", { gkKeys: ["e:ann@agent.test"], dryRun: false });
    assert.match(r.results[0].skipped, /already in GHL as an agent or buyer \(tag: agent\)/);
    assert.equal(ghl.writes.filter((w) => w.method !== "GET").length, 0, "nothing written to them");
    assert.equal((await store.getGatekeeper(LOC, "e:ann@agent.test")).status, "new");
  } finally {
    delete process.env.OUTREACH_IMPORTS_ENABLED;
  }
});

test("do-not-contact is never imported, and an imported gatekeeper can't be reset to new", async () => {
  process.env.OUTREACH_IMPORTS_ENABLED = "true";
  try {
    const s = await post(`/${encodeURIComponent("e:kim@exampletitle.test")}/status`, { status: "do_not_contact" });
    assert.equal(s.ok, true);
    ghl.writes.length = 0;
    const r = await post("/import", { gkKeys: ["e:kim@exampletitle.test"], dryRun: false });
    assert.equal(r.results[0].skipped, "do not contact");
    assert.equal(ghl.writes.length, 0);
    const back = await post(`/${encodeURIComponent("wsba:28877")}/status`, { status: "new" });
    assert.match(back.error, /already imported/);
  } finally {
    delete process.env.OUTREACH_IMPORTS_ENABLED;
  }
});
