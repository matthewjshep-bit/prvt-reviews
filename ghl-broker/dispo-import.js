// dispo-import.js — bring a borrower list into GHL as buyers, from the
// Dispositions page. Upload → preview (no GHL calls: who, where, what they do)
// → import as a background job that finds each person in GHL, fills blanks or
// creates them, tags them by market and strategy, and records every property
// they financed on their timeline.
//
// Same double gate as the outreach import: nothing is written unless the
// request says dryRun:false AND DISPO_IMPORTS_ENABLED=true. A dry job still
// looks every buyer up, so it tells you exactly what a live one would do.

import { findDuplicateContact, createContact, updateContact, addContactTags } from "./ghl.js";
import { recordEvents } from "./contact-record.js";
import { parseCsv, groupBuyers, purchaseEvents, withRetry, sleep, e164 } from "./buyer-import.js";

export const DISPO_IMPORTS_ENABLED = process.env.DISPO_IMPORTS_ENABLED === "true";
const PACE_MS = 150;
const PREVIEW_TTL_MS = 6 * 3600 * 1000;

const sanitizeTag = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/* ---------- previews (in memory — a restart just means upload again) ---------- */

const previews = new Map(); // previewId -> { locationId, buyers, skipped, createdAt, fileName }

/**
 * previewCsv({ locationId, csv, fileName }) → { previewId, buyers (slim), skipped, counts }
 * Pure reading: no GHL calls, so a 2,500-row list previews instantly.
 */
export function previewCsv({ locationId, csv, fileName = "" }) {
  const rows = parseCsv(String(csv || ""));
  if (!rows.length) throw Object.assign(new Error("That file has no rows."), { http: 400 });
  if (!("Last Property City" in rows[0])) {
    throw Object.assign(new Error("This doesn't look like a borrower list export — expected columns like \"Last Property City\" and \"Last Lender\"."), { http: 400 });
  }
  const { buyers, skipped } = groupBuyers(rows);
  for (const [id, p] of previews) if (Date.now() - p.createdAt > PREVIEW_TTL_MS) previews.delete(id);
  const previewId = `pv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  previews.set(previewId, { locationId, buyers, skipped, createdAt: Date.now(), fileName });

  const tally = (pick) => buyers.reduce((a, b) => { for (const k of pick(b)) a[k] = (a[k] || 0) + 1; return a; }, {});
  return {
    previewId, fileName, rows: rows.length,
    skipped: skipped.length,
    counts: {
      buyers: buyers.length,
      contactable: buyers.filter((b) => b.phones.length || b.emails.length).length,
      noContactInfo: buyers.filter((b) => !b.phones.length && !b.emails.length).length,
      regions: tally((b) => b.regions), types: tally((b) => b.types), states: tally((b) => b.states),
    },
    buyers: buyers.map((b) => ({
      key: b.key, name: `${b.firstName} ${b.lastName}`.trim(), phone: b.phones[0] || "", email: b.emails[0] || "",
      cities: b.cities, regions: b.regions, types: b.types, states: b.states,
      purchases: b.purchases.length, lastAt: b.lastAt, largest: b.largest, tags: b.tags,
    })),
  };
}

/* ---------- the job ---------- */

const jobs = new Map(); // locationId -> job
export const getImportJob = (locationId) => jobs.get(locationId) || null;
export function publicImportJob(job) {
  if (!job) return null;
  const { cancelRequested, ...rest } = job;
  return { ...rest, results: rest.results.slice(-200), stopping: Boolean(cancelRequested && job.status === "running") };
}
export function cancelImport(locationId) {
  const job = jobs.get(locationId);
  if (!job || job.status !== "running") return false;
  job.cancelRequested = true;
  return true;
}

/**
 * startImport({ client, store, locationId, previewId, keys, batch, dryRun }) → job
 * `keys` limits the run to the buyers ticked in the preview (all when empty).
 */
export function startImport({ client, store, locationId, previewId, keys = [], batch = "", dryRun = true }) {
  const preview = previews.get(previewId);
  if (!preview || preview.locationId !== locationId) {
    throw Object.assign(new Error("That preview has expired — upload the file again."), { http: 410 });
  }
  if (jobs.get(locationId)?.status === "running") throw Object.assign(new Error("an import is already running"), { http: 409 });
  const want = new Set(keys);
  const buyers = want.size ? preview.buyers.filter((b) => want.has(b.key)) : preview.buyers;
  const live = !dryRun && DISPO_IMPORTS_ENABLED;
  const batchTag = sanitizeTag(`dispo-import-${batch || preview.fileName.replace(/\.csv$/i, "") || new Date().toISOString().slice(0, 10)}`);
  const job = {
    id: `imp-${Date.now().toString(36)}`, status: "running", dryRun: !live, requestedLive: !dryRun, importsEnabled: DISPO_IMPORTS_ENABLED,
    batchTag, startedAt: new Date().toISOString(), finishedAt: null,
    total: buyers.length, done: 0,
    counts: { created: 0, updated: 0, skipped: 0, errors: 0, purchases: 0 },
    results: [], error: null, cancelRequested: false,
  };
  jobs.set(locationId, job);
  run(job, { client, store, locationId, buyers, live, source: preview.fileName }).catch((e) => {
    job.status = "error"; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = new Date().toISOString();
  });
  return job;
}

async function run(job, { client, store, locationId, buyers, live, source }) {
  const push = (r) => { job.results.push(r); if (job.results.length > 2000) job.results.shift(); };
  for (const b of buyers) {
    if (job.cancelRequested) break;
    const name = `${b.firstName} ${b.lastName}`.trim();
    const phone = e164(b.phones[0] || "");
    const email = b.emails[0] || "";
    try {
      if (!phone && !email) {
        job.counts.skipped++;
        push({ name, action: "skip", reason: "no phone or email to reach them" });
      } else {
        const match = await withRetry(() => findDuplicateContact(client, locationId, { email, phone }));
        const tags = [...b.tags, "investor", job.batchTag];
        let contactId = match?.id || "";
        if (match) {
          // Fill blanks only — never overwrite what's on a live contact.
          const patch = {};
          if (email && match.matchedBy !== "email") patch.email = email;
          if (phone && match.matchedBy !== "phone") patch.phone = phone;
          if (live) {
            if (Object.keys(patch).length) await withRetry(() => updateContact(client, contactId, patch)).catch(() => {});
            await withRetry(() => addContactTags(client, contactId, tags));
          }
          job.counts.updated++;
          push({ name, action: live ? "updated" : "would update", matchedBy: match.matchedBy, contactId, tags: tags.join(" ") });
        } else {
          if (live) {
            contactId = await withRetry(() => createContact(client, locationId, {
              firstName: b.firstName, lastName: b.lastName, ...(phone ? { phone } : {}), ...(email ? { email } : {}),
              source: `borrower list ${source || ""}`.trim(), tags,
            }));
          }
          job.counts.created++;
          push({ name, action: live ? "created" : "would create", contactId, tags: tags.join(" ") });
        }
        if (live && contactId) {
          const r = await recordEvents({ store, locationId, contactId, party: "investor", events: purchaseEvents(b.purchases) });
          job.counts.purchases += r.inserted || 0;
        }
      }
    } catch (e) {
      job.counts.errors++;
      push({ name, action: "error", reason: `${e.status || ""} ${e.message}`.trim().slice(0, 160) });
    }
    job.done++;
    await sleep(PACE_MS);
  }
  job.status = job.cancelRequested ? "canceled" : "done";
  job.finishedAt = new Date().toISOString();
}
