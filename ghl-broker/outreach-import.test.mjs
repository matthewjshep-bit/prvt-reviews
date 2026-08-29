// outreach-import.test.mjs — what the Agent Outreach import actually writes
// onto a GHL contact. Drives the real route with a recording fake client, so
// this exercises shipped code rather than a restatement of its rules.
//
// The property under test: a NEW contact always leaves the import carrying the
// hook address as its Subject Property, and a re-import never overwrites one
// the conversation has since moved on.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-test-"));
process.env.OUTREACH_IMPORTS_ENABLED = "true";

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");

const LOC = "loc-outreach-1";
const HOOK = "1911 9th Ave W, Seattle, WA 98119";
// Port 0: the OS picks a free one. The suite runs test FILES in parallel, and
// a hardcoded port makes this file fail depending on what else is running.

// A fake LeadConnector. Returns a stable field id per key, answers the dedupe
// check from `duplicate`, and records every write so the test can assert on
// what the contact ended up with.
function fakeGhl({ duplicate = null, existingFields = [] } = {}) {
  const calls = [];
  const ids = new Map();
  const idFor = (name) => {
    if (!ids.has(name)) ids.set(name, `fld-${ids.size + 1}-${name.replace(/\W+/g, "_")}`);
    return ids.get(name);
  };
  return {
    calls,
    idFor,
    client: {
      async call(pathname, opts = {}) {
        const method = opts.method || "GET";
        calls.push({ method, path: pathname, body: opts.body });
        if (method === "GET" && /\/customFields$/.test(pathname)) {
          // Every field already exists, so findOrCreateCustomFieldByKey resolves
          // by fieldKey without creating anything.
          return { customFields: [...ids.keys()].map((n) => ({ id: idFor(n), name: n, fieldKey: `contact.${n}` })) };
        }
        if (method === "POST" && /\/customFields$/.test(pathname)) {
          const n = opts.body?.name;
          return { customField: { id: idFor(n), name: n, fieldKey: `contact.${n}` } };
        }
        if (/\/contacts\/search\/duplicate/.test(pathname)) return { contact: duplicate };
        if (method === "GET" && /\/contacts\/[^/]+$/.test(pathname)) {
          return { contact: { id: duplicate?.id || "c1", customFields: existingFields } };
        }
        if (method === "POST" && pathname === "/contacts/") return { contact: { id: "c-new" } };
        return {};
      },
    },
  };
}

// Pre-resolve the field ids the way the route will, so assertions can name a
// field by key rather than by an opaque id.
const FIELD_NAMES = {
  subject_property: "Subject Property",
  hook_address: "Hook Address",
};

async function runImport(ghl) {
  const app = express();
  app.use(express.json());
  app.use("/api/outreach", createOutreachRouter({
    resolveLocation: () => ({ locationId: LOC, client: ghl.client }),
  }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const B = `http://127.0.0.1:${server.address().port}`;
  try {
    const batch = await store.createOutreachBatch(LOC, { name: "test batch" });
    await store.upsertOutreachAgents(LOC, batch.id, [{
      agentKey: "e:agent@example.com",
      doc: {
        name: "Test Agent", firstName: "Test", lastName: "Agent",
        email: "agent@example.com", phone: "2065550123", brokerage: "Test Realty",
        hook: { address: HOOK, price: 750000, dom: 90 },
      },
    }]);
    const r = await fetch(`${B}/api/outreach/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location_id: LOC, batchId: batch.id,
        agentKeys: ["e:agent@example.com"], dryRun: false, applyTag: false,
      }),
    });
    return await r.json();
  } finally {
    server.close();
  }
}

// Every customFields payload the route PUT to the contact, flattened to
// { fieldName: value }.
const writtenFields = (ghl) => {
  const out = {};
  for (const c of ghl.calls) {
    for (const f of c.body?.customFields || []) {
      const name = Object.values(FIELD_NAMES).find((n) => ghl.idFor(n) === f.id);
      if (name) out[name] = f.value;
    }
  }
  return out;
};

await store.init();

test("a NEW contact leaves the import carrying the hook address as its Subject Property", async () => {
  const ghl = fakeGhl({ duplicate: null });          // no match -> create path
  for (const n of Object.values(FIELD_NAMES)) ghl.idFor(n);
  const res = await runImport(ghl);
  assert.equal(res.results?.[0]?.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].action, "created");

  const fields = writtenFields(ghl);
  assert.equal(fields["Subject Property"], HOOK);
  assert.equal(fields["Hook Address"], HOOK);        // both, and they start equal
});

test("an existing contact with no Subject Property gets seeded too", async () => {
  const ghl = fakeGhl({ duplicate: { id: "c-existing" }, existingFields: [] });
  for (const n of Object.values(FIELD_NAMES)) ghl.idFor(n);
  const res = await runImport(ghl);
  assert.equal(res.results[0].action, "updated");
  assert.equal(writtenFields(ghl)["Subject Property"], HOOK);
});

test("a re-import never overwrites a Subject Property the conversation moved on", async () => {
  const ghl = fakeGhl({ duplicate: { id: "c-existing" } });
  const subjectId = ghl.idFor("Subject Property");
  ghl.idFor("Hook Address");
  const moved = "7130 Bentley Rd E, Puyallup, WA";
  const ghl2 = fakeGhl({ duplicate: { id: "c-existing" }, existingFields: [{ id: subjectId, value: moved }] });
  // Same id allocation order, so subjectId lines up.
  ghl2.idFor("Subject Property");
  ghl2.idFor("Hook Address");

  const res = await runImport(ghl2);
  assert.equal(res.results[0].action, "updated");
  const fields = writtenFields(ghl2);
  assert.equal(fields["Subject Property"], undefined, "must not be written at all");
  assert.equal(fields["Hook Address"], HOOK, "the hook itself is still refreshed");
});
