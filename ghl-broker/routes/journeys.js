// routes/journeys.js — Journeys v1: mapped multi-step card+text lifecycles.
// NO scheduler — steps are fired manually from the UI ("send this step");
// waits are planning labels. Sends reuse the standard machinery: DND excluded,
// CARD_SENDS_ENABLED gate, cap, throttle, per-contact render (tier data
// injected), direct MMS, logged to home_sends as section "journey:<id>".
//
//   GET    /api/journeys                     list (+active counts)
//   POST   /api/journeys                     create
//   GET    /api/journeys/:id                 fetch (doc + enrollments)
//   PUT    /api/journeys/:id                 update
//   DELETE /api/journeys/:id                 delete
//   POST   /api/journeys/:id/enroll          { contactIds?, tag? }
//   DELETE /api/journeys/:id/enrollments/:contactId
//   POST   /api/journeys/:id/steps/:step/send { dryRun=true }

import express from "express";
import { store } from "../store.js";
import {
  getContact, searchContactsByTag, sendSms, listCustomValues,
  customFieldIdKeyMap, contactCustomRecord,
} from "../ghl.js";
import { resolveBindings } from "../shared/bindings.js";
import { effectiveTiers, resolveTier } from "../home-config.js";

const CARD_SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";
const CAMPAIGN_CAP = parseInt(process.env.CAMPAIGN_CAP || "200", 10);
const THROTTLE_MS = 150;

const isDnd = (c) => Boolean(c?.dnd ?? c?.contact?.dnd);
const firstNameOf = (c) => c?.firstName || c?.contact?.firstName || "";

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : 0; };
const money = (v) => { const n = num(v); if (!n) return "$0"; if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`; if (n >= 1e4) return `$${Math.round(n / 1e3)}k`; return `$${n.toLocaleString("en-US")}`; };

// Validate + normalize a journey doc from the client.
function cleanDoc(body, locationId) {
  const name = String(body.name || "").trim() || "Untitled journey";
  const steps = Array.isArray(body.steps) ? body.steps.slice(0, 20).map((s) => ({
    templateId: String(s.templateId || ""),
    message: typeof s.message === "string" ? s.message.slice(0, 1000) : "",
    waitDays: Math.max(0, Math.min(365, parseInt(s.waitDays, 10) || 0)),
  })) : [];
  return { locationId, name, active: body.active !== false, steps };
}

export default function createJourneysRouter({ resolveLocation, renderRouter }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("journeys error:", code, err.message, err.data || "");
    res.status(code).json({ error: err.message, detail: err.detail || err.data });
  };
  const ownedOr404 = async (id, locationId) => {
    const j = await store.getJourney(id);
    if (!j || j.locationId !== locationId) throw Object.assign(new Error("journey not found"), { http: 404 });
    return j;
  };

  // Per-contact data.tier overrides (same semantics as Home sends).
  async function tierOverrides(client, locationId, contact) {
    try {
      const cvs = await listCustomValues(client, locationId);
      const cvByName = Object.fromEntries(cvs.map((c) => [c.name, c.value]));
      const rec = contactCustomRecord(contact, await customFieldIdKeyMap(client, locationId));
      const tier = resolveTier(rec, effectiveTiers(cvByName));
      const proof = `${num(rec.deal_count)} deals · ${money(rec.deal_volume)} · ${num(rec.late_payment_count)} late payments`;
      return {
        overrides: { tier: { id: tier.id, label: tier.label, rate: tier.terms?.rate || "", down: tier.terms?.down || "", proof } },
        reviewLink: cvByName["rh_review_link"] || "",
      };
    } catch {
      return { overrides: undefined, reviewLink: "" };
    }
  }

  /* ---------- CRUD ---------- */
  router.get("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const [journeys, counts] = await Promise.all([
        store.listJourneys(locationId),
        store.activeJourneyCounts(locationId),
      ]);
      res.json({ ok: true, journeys: journeys.map((j) => ({ ...j, activeCount: counts[j.id] || 0 })) });
    } catch (err) { fail(res, err); }
  });

  router.post("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const doc = cleanDoc(req.body || {}, locationId);
      res.status(201).json({ ok: true, journey: await store.createJourney(doc) });
    } catch (err) { fail(res, err); }
  });

  router.get("/:id", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const journey = await ownedOr404(req.params.id, locationId);
      const enrollments = await store.listEnrollments(journey.id);
      res.json({ ok: true, journey, enrollments, sendsEnabled: CARD_SENDS_ENABLED });
    } catch (err) { fail(res, err); }
  });

  router.put("/:id", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      await ownedOr404(req.params.id, locationId);
      const doc = cleanDoc(req.body || {}, locationId);
      res.json({ ok: true, journey: await store.updateJourney(req.params.id, doc) });
    } catch (err) { fail(res, err); }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      await ownedOr404(req.params.id, locationId);
      res.json({ ok: await store.deleteJourney(req.params.id) });
    } catch (err) { fail(res, err); }
  });

  /* ---------- enrollment ---------- */
  router.post("/:id/enroll", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const journey = await ownedOr404(req.params.id, locationId);
      const { contactIds = [], tag = "" } = req.body || {};

      const ids = new Set((contactIds || []).filter(Boolean));
      if (tag) {
        const { contacts } = await searchContactsByTag(client, locationId, tag, { max: CAMPAIGN_CAP });
        for (const c of contacts) { const id = c?.id || c?.contact?.id; if (id) ids.add(id); }
      }
      if (!ids.size) return res.status(400).json({ error: "contactIds or tag required" });

      const enrolled = await store.enrollContacts(journey.id, locationId, [...ids]);
      res.json({ ok: true, requested: ids.size, enrolled, skippedExisting: ids.size - enrolled });
    } catch (err) { fail(res, err); }
  });

  router.delete("/:id/enrollments/:contactId", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      await ownedOr404(req.params.id, locationId);
      res.json({ ok: await store.removeEnrollment(req.params.id, req.params.contactId) });
    } catch (err) { fail(res, err); }
  });

  /* ---------- manual step send ---------- */
  router.post("/:id/steps/:step/send", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const journey = await ownedOr404(req.params.id, locationId);
      const stepIndex = parseInt(req.params.step, 10);
      const step = journey.steps?.[stepIndex];
      if (!step) return res.status(400).json({ error: `no step ${stepIndex}` });
      if (!step.templateId) return res.status(422).json({ error: "this step has no card assigned yet" });
      const template = await store.getTemplate(step.templateId);
      if (!template || template.locationId !== locationId) return res.status(422).json({ error: "this step's card no longer exists" });

      const { dryRun = true } = req.body || {};
      const atStep = (await store.listEnrollments(journey.id))
        .filter((e) => e.status === "active" && e.stepIndex === stepIndex)
        .slice(0, CAMPAIGN_CAP);

      // Resolve contacts + DND up front (dry-run reports the real audience).
      const resolved = [];
      let skippedDnd = 0;
      for (const e of atStep) {
        try {
          const c = await getContact(client, e.contactId);
          if (isDnd(c)) { skippedDnd++; continue; }
          resolved.push({ id: e.contactId, contact: c });
        } catch { /* unresolvable contact — skip */ }
      }

      const live = dryRun === false && CARD_SENDS_ENABLED;
      if (!live) {
        return res.json({
          ok: true, dryRun: true, sendsEnabled: CARD_SENDS_ENABLED,
          stepIndex, atStep: atStep.length, skippedDnd, willSend: resolved.length,
          cap: CAMPAIGN_CAP, sample: resolved.slice(0, 5).map((r) => firstNameOf(r.contact) || r.id),
        });
      }

      let sent = 0, failed = 0;
      const advanced = [];
      const errors = [];
      for (const r of resolved) {
        try {
          const { overrides, reviewLink } = await tierOverrides(client, locationId, r.contact);
          const gen = await renderRouter.generate({
            client, locationId, templateId: step.templateId, contactId: r.id, force: false, dataOverrides: overrides,
          });
          const raw = (step.message || template.message || "").replace(/\[Review Link\]/g, reviewLink);
          const text = resolveBindings(raw, gen.context).value || " ";
          await sendSms(client, { contactId: r.id, message: text, attachments: [gen.url] });
          await store.logHomeSend({ locationId, section: `journey:${journey.id}`, contactId: r.id, triggerTag: null, cardUrl: gen.url, batchId: `step${stepIndex}` });
          advanced.push(r.id);
          sent++;
        } catch (e) {
          failed++;
          if (errors.length < 5) errors.push({ who: firstNameOf(r.contact) || r.id, error: e?.message || "error" });
        }
        await new Promise((rr) => setTimeout(rr, THROTTLE_MS));
      }

      const isLast = stepIndex >= (journey.steps.length - 1);
      await store.advanceEnrollments(journey.id, stepIndex, advanced, isLast);

      res.json({ ok: true, sent, failed, skippedDnd, advanced: advanced.length, completed: isLast ? advanced.length : 0, errors });
    } catch (err) { fail(res, err); }
  });

  return router;
}
