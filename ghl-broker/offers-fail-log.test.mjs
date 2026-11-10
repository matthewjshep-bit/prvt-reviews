// offers-fail-log.test.mjs — what the offers router's error path writes to
// the log (routes/offers.js fail()).
//
//   node --test offers-fail-log.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offers-fail-log-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => { throw Object.assign(new Error("GHL GET /contacts/search/duplicate?email=ray.fake%40example.com: 500 for ray.fake@example.com"), { detail: "phone +1 206 555 0144 on file" }); },
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4997",
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

// 2026-11-09 audit: a 500 logged the error's text and detail whole, and GHL's
// error text carries the lookup it made, email and all.
test("a server error's log line carries no email or phone", async () => {
  const logged = [];
  const real = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  let r;
  try {
    r = await fetch(`${B}/api/offers/automations/ai-spend`);
  } finally { console.error = real; }
  assert.equal(r.status, 500);
  const line = logged.find((s) => /offers error/.test(s));
  assert.ok(line, logged.join("\n"));
  assert.doesNotMatch(line, /ray\.fake|example\.com|555 0144|%40/, line);
  assert.match(line, /GHL GET \/contacts\/search\/duplicate: 500 for <email>/);
});
