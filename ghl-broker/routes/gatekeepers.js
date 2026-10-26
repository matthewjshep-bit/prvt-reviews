// routes/gatekeepers.js — the gatekeeper line (Matt, 2026-10-26): attorneys
// on estates (from probate Notices to Creditors) and the title and escrow
// officers we close with, ranked, and imported to GHL apart from agents.
// Mounted at /api/gatekeepers.
//
//   GET  /api/gatekeepers                      ranked gatekeepers + their hooks (?kind=, ?status=)
//   POST /api/gatekeepers/notices              { text } paste or CSV of notices → attorneys + estates
//   POST /api/gatekeepers/notices/mail         read the notice alert email now
//   POST /api/gatekeepers/seed-closings        title / escrow from our own deals
//   POST /api/gatekeepers                      add or edit one by hand (title, escrow)
//   POST /api/gatekeepers/:gkKey/status        { status } skip / do-not-contact / back to new
//   POST /api/gatekeepers/import               { gkKeys, dryRun } → GHL contacts, tagged
//   GET  /api/gatekeepers/sweep                the daily sweep: last run, running job
//   POST /api/gatekeepers/sweep/run            { dryRun } run it now (gatekeeper-sweep.js)
//
// Nothing here sends a text or an email: the sweep writes drafts. The import is dry unless the
// request says dryRun:false AND OUTREACH_IMPORTS_ENABLED is set — the same
// double gate as the agent import. Errors and results carry counts and keys,
// never a name.

import express from "express";
import { store } from "../store.js";
import { ensureProfile, recordEvents } from "../contact-record.js";
import { findDuplicateContact, createContact, getContact, updateContact, addContactTags } from "../ghl.js";
import { matchTagPatterns } from "../conversation-party.js";
import { conversationConfig } from "../reply-agent.js";
import { ingestNotices, readNoticeEmails, seedFromClosings } from "../gatekeeper-feed.js";
import { startGatekeeperSweep, getGatekeeperJob, CURSOR_NAME as SWEEP_CURSOR } from "../gatekeeper-sweep.js";
import {
  GATEKEEPER_KINDS, GATEKEEPER_STATUSES, gatekeeperKey, mergeGatekeeperDoc, rankGatekeepers, bestHook, hookLine, splitName,
} from "../shared/gatekeeper.js";

const OUTREACH_IMPORTS_ENABLED = () => process.env.OUTREACH_IMPORTS_ENABLED === "true";
export const MAX_IMPORT = 100;
const MAX_NOTICE_TEXT = 2_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status !== 429 || attempt >= 2) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}
const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
const e164 = (p) => (digits(p).length === 10 ? `+1${digits(p)}` : "");
const firstEmail = (raw) => String(raw || "").split(/[;,\s]+/).find((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) || "";
const tagSlug = (s) => String(s || "").toLowerCase().replace(/_/g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

/** The tags a gatekeeper carries in GHL: the cohort, the kind, and where we found them. */
export function gatekeeperTags(row) {
  const src = (row?.doc?.sources || []).map((s) => (String(s).startsWith("probate-notice") ? "probate-notice" : s));
  return [...new Set(["gatekeeper", `gatekeeper-${tagSlug(row?.kind)}`, ...src.map((s) => `gatekeeper-src-${tagSlug(s)}`)])];
}

export default function createGatekeepersRouter({ resolveLocation, deps = {} }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("gatekeepers error:", code, err.message);
    res.status(code).json({ error: err.message });
  };
  const getSettings = async (locationId) => (await store.getOfferSettings(locationId)) || {};

  async function ranked(locationId, { kind = null, status = null } = {}) {
    const [rows, hooks] = await Promise.all([
      store.listGatekeepers(locationId, { kind, status }),
      store.listGatekeeperHooks(locationId),
    ]);
    const flatHooks = hooks.map((h) => ({ ...h.doc, hookKey: h.hookKey, gkKey: h.gkKey, kind: h.kind, firstSeen: h.firstSeen }));
    const byKey = new Map();
    for (const h of flatHooks) {
      if (!byKey.has(h.gkKey)) byKey.set(h.gkKey, []);
      byKey.get(h.gkKey).push(h);
    }
    return rankGatekeepers(rows.map((r) => ({ ...r.doc, gkKey: r.gkKey, kind: r.kind, status: r.status, contactId: r.contactId, importedAt: r.importedAt, firstSeen: r.firstSeen })), flatHooks)
      .map((g) => {
        const mine = byKey.get(g.gkKey) || [];
        const hook = bestHook(mine);
        return { ...g, hook, hookLine: hookLine(hook), hooks: mine.length };
      });
  }

  router.get("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const kind = GATEKEEPER_KINDS.includes(req.query.kind) ? req.query.kind : null;
      const status = GATEKEEPER_STATUSES.includes(req.query.status) ? req.query.status : null;
      const list = await ranked(locationId, { kind, status });
      const counts = {};
      for (const g of list) counts[g.kind] = (counts[g.kind] || 0) + 1;
      res.json({ gatekeepers: list, counts, importsLive: OUTREACH_IMPORTS_ENABLED() });
    } catch (err) { fail(res, err); }
  });

  router.get("/:gkKey/hooks", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const hooks = await store.listGatekeeperHooks(locationId, { gkKey: req.params.gkKey });
      res.json({ hooks: hooks.map((h) => ({ ...h.doc, hookKey: h.hookKey, kind: h.kind, firstSeen: h.firstSeen, line: hookLine({ ...h.doc, kind: h.kind }) })) });
    } catch (err) { fail(res, err); }
  });

  router.post("/notices", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const text = String(req.body?.text || "");
      if (!text.trim()) throw Object.assign(new Error("text required"), { http: 400 });
      if (text.length > MAX_NOTICE_TEXT) throw Object.assign(new Error("too much text — paste it in parts"), { http: 413 });
      const r = await ingestNotices({ store, locationId, text, source: "paste", settings: await getSettings(locationId), deps });
      console.log(`gatekeepers: ${r.notices} notices pasted → ${r.attorneys.created} new attorneys, ${r.estates.created} new estates, ${r.housesFound} houses`);
      res.json(r);
    } catch (err) { fail(res, err); }
  });

  router.post("/notices/mail", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json(await readNoticeEmails({ store, locationId, settings: await getSettings(locationId), deps }));
    } catch (err) { fail(res, err); }
  });

  router.post("/seed-closings", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json(await seedFromClosings({ store, locationId, settings: await getSettings(locationId) }));
    } catch (err) { fail(res, err); }
  });

  // Add or edit one by hand. Title and escrow have no feed: Matt types them
  // in (or pastes a few rows) after a closing or a call.
  router.post("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body || {}];
      const saved = [];
      const skipped = [];
      for (const raw of rows.slice(0, 500)) {
        const kind = GATEKEEPER_KINDS.includes(raw.kind) ? raw.kind : "title";
        const doc = {
          name: String(raw.name || "").trim(), ...splitName(raw.name), firm: String(raw.firm || raw.company || "").trim(),
          phone: digits(raw.phone), email: firstEmail(raw.email).toLowerCase(), barNo: String(raw.barNo || "").replace(/\D/g, ""),
          note: String(raw.note || "").trim().slice(0, 500),
        };
        const gkKey = raw.gkKey || gatekeeperKey({ kind, ...doc });
        if (!gkKey || !(doc.name || doc.firm)) { skipped.push({ reason: "needs a name or a company" }); continue; }
        const prev = (await store.getGatekeeper(locationId, gkKey))?.doc || {};
        const merged = mergeGatekeeperDoc(prev, doc);
        // A hand edit wins over what we had for the fields it names.
        for (const k of ["name", "firstName", "lastName", "firm", "phone", "email", "barNo", "note"]) if (doc[k]) merged[k] = doc[k];
        merged.sources = [...new Set([...(prev.sources || []), "by-hand"])];
        await store.upsertGatekeepers(locationId, [{ gkKey, kind, doc: merged }]);
        if (raw.closingAddress) {
          await store.upsertGatekeeperHooks(locationId, [{ hookKey: `file:${gkKey}:${String(raw.closingAddress).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, gkKey, kind: "closing", doc: { address: String(raw.closingAddress).trim() } }]);
        }
        saved.push(gkKey);
      }
      res.json({ ok: true, saved, skipped });
    } catch (err) { fail(res, err); }
  });

  router.post("/:gkKey/status", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const status = String(req.body?.status || "");
      if (!["new", "skipped", "do_not_contact"].includes(status)) throw Object.assign(new Error("status must be new, skipped or do_not_contact"), { http: 400 });
      const row = await store.getGatekeeper(locationId, req.params.gkKey);
      if (!row) throw Object.assign(new Error("unknown gatekeeper"), { http: 404 });
      if (row.status === "imported" && status === "new") throw Object.assign(new Error("already imported"), { http: 409 });
      await store.setGatekeeperStatus(locationId, req.params.gkKey, { status });
      res.json({ ok: true, status });
    } catch (err) { fail(res, err); }
  });

  /**
   * importGatekeepers({ locationId, client, gkKeys, dryRun }) → { dryRun, results }
   *
   * Each one becomes a GHL contact tagged `gatekeeper`, `gatekeeper-<kind>`
   * and where we found them — never the agent-outreach trigger tag, so no
   * agent workflow picks them up. One already in GHL is tagged, not
   * created, and nothing they have is overwritten — unless GHL has them as
   * an agent or a buyer we work with: the gatekeeper tag would take them
   * off the bot (reply-agent.js handsOffReason), so they're left as they
   * are. A do-not-contact row is never imported.
   */
  async function importGatekeepers({ locationId, client, gkKeys = [], dryRun = true }) {
    gkKeys = Array.isArray(gkKeys) ? [...new Set(gkKeys)].slice(0, MAX_IMPORT) : [];
    if (!gkKeys.length) throw Object.assign(new Error("gkKeys required"), { http: 400 });
    dryRun = dryRun !== false || !OUTREACH_IMPORTS_ENABLED();
    const hooks = await store.listGatekeeperHooks(locationId);
    const routing = conversationConfig(await getSettings(locationId)).routing || {};
    const theirsAlready = (contact) => matchTagPatterns(contact?.tags || [], [...(routing.agentTags || []), ...(routing.investorTags || [])])[0] || "";
    const results = [];
    for (const gkKey of gkKeys) {
      try {
        const row = await store.getGatekeeper(locationId, gkKey);
        if (!row) { results.push({ gkKey, ok: false, error: "unknown gatekeeper" }); continue; }
        if (row.status === "do_not_contact") { results.push({ gkKey, ok: true, skipped: "do not contact" }); continue; }
        if (row.status === "imported") { results.push({ gkKey, ok: true, alreadyImported: true, contactId: row.contactId }); continue; }
        const d = row.doc || {};
        const email = firstEmail(d.email);
        const phone = e164(d.phone);
        if (!email && !phone) { results.push({ gkKey, ok: false, error: "no email or phone yet" }); continue; }
        const tags = gatekeeperTags(row);
        await sleep(150);
        const match = await withRetry(() => findDuplicateContact(client, locationId, { email, phone }));
        const existing = match ? await withRetry(() => getContact(client, match.id)) : null;
        const asAgent = theirsAlready(existing);
        if (asAgent) {
          results.push({ gkKey, ok: true, skipped: `already in GHL as an agent or buyer (tag: ${asAgent}) — left as they are`, contactId: match.id });
          continue;
        }
        if (dryRun) {
          results.push({ gkKey, ok: true, dryRun: true, ...(match ? { wouldUpdate: true, contactId: match.id, matchedBy: match.matchedBy } : { wouldCreate: true }), tags });
          continue;
        }
        let contactId;
        let action;
        if (match) {
          contactId = match.id;
          action = "updated";
          const patch = {};
          if (!existing.phone && phone) patch.phone = phone;
          if (!existing.email && email) patch.email = email;
          if (!existing.companyName && d.firm) patch.companyName = d.firm;
          if (Object.keys(patch).length) await withRetry(() => updateContact(client, contactId, patch));
        } else {
          action = "created";
          contactId = await withRetry(() => createContact(client, locationId, {
            firstName: d.firstName || d.name || d.firm || "Gatekeeper", lastName: d.lastName || "",
            ...(phone ? { phone } : {}), ...(email ? { email } : {}), ...(d.firm ? { companyName: d.firm } : {}),
            source: "gatekeeper",
          }));
        }
        if (!contactId) throw new Error("no contact id returned");
        await withRetry(() => addContactTags(client, contactId, tags));
        const hook = bestHook(hooks.filter((h) => h.gkKey === gkKey).map((h) => ({ ...h.doc, kind: h.kind, hookKey: h.hookKey, firstSeen: h.firstSeen })));
        try {
          const at = new Date().toISOString();
          await ensureProfile({ store, locationId, contactId, party: "gatekeeper", name: d.name || d.firm || null, phone: phone || null, email: email || null });
          await recordEvents({ store, locationId, contactId, party: "gatekeeper", events: [
            { type: "import", at, address: hook?.house?.address || hook?.address || "", source: "gatekeeper-import", ref: `gatekeeper:${gkKey}`,
              data: { action, gkKey, kind: row.kind, hookKey: hook?.hookKey || null } },
            ...tags.map((tag) => ({ type: "tag_added", at, source: "gatekeeper-import", ref: `gatekeeper:${gkKey}`, data: { tag } })),
          ] });
        } catch (e) { console.error(`gatekeepers: record for ${gkKey}: ${e.message}`); }
        await store.setGatekeeperStatus(locationId, gkKey, { status: "imported", contactId, importedAt: new Date().toISOString() });
        results.push({ gkKey, ok: true, action, contactId });
      } catch (e) {
        results.push({ gkKey, ok: false, error: e.message });
      }
    }
    return { dryRun, results, created: results.filter((r) => r.action === "created").length, updated: results.filter((r) => r.action === "updated").length };
  }
  router.importGatekeepers = importGatekeepers;

  router.get("/sweep", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const cursor = await store.getJobCursor(locationId, SWEEP_CURSOR).catch(() => null);
      const job = getGatekeeperJob(locationId);
      res.json({ last: cursor?.doc?.last || null, lastDaily: cursor?.doc?.lastDaily || null, tries: cursor?.doc?.tries || 0,
        failed: Boolean(cursor?.doc?.failed), error: cursor?.doc?.error || null,
        job: job ? { status: job.status, trigger: job.trigger, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error, steps: job.result?.steps || null } : null });
    } catch (err) { fail(res, err); }
  });

  // Run the day's sweep now. Dry unless asked otherwise, and even then
  // only as live as Settings allow (the sweep reads gatekeepers.dryRun).
  router.post("/sweep/run", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      if (getGatekeeperJob(locationId)?.status === "running") throw Object.assign(new Error("a sweep is already running"), { http: 409 });
      const saved = await getSettings(locationId);
      const dryRun = req.body?.dryRun === false ? null : true;
      const job = startGatekeeperSweep({ client, locationId, saved, store, sendsEnabled: process.env.CARD_SENDS_ENABLED === "true",
        deps: { ...deps, importGatekeepers }, dryRun, trigger: "manual" });
      if (req.body?.wait) await job.done;
      res.json({ ok: true, job: { status: job.status, startedAt: job.startedAt, ...(job.result ? { dryRun: job.result.dryRun, steps: job.result.steps, imported: job.result.imported, rows: job.result.rows.slice(0, 100) } : {}) } });
    } catch (err) { fail(res, err); }
  });

  router.post("/import", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      res.json(await importGatekeepers({ locationId, client, gkKeys: req.body?.gkKeys, dryRun: req.body?.dryRun }));
    } catch (err) { fail(res, err); }
  });

  return router;
}
