// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// machine-health.js — the paid keys the machine runs on, and the failures
// that stop the business. Pure: what's read in, what to say out.
//
// 2026-11-23 audit. One Apify token feeds auto-underwrite's comps and photos,
// the outreach listing check, price watch and the lot finder's builder scan.
// It was rejected from 11-11 to 11-18 and nothing said so where Matt looks:
// every underwrite stopped early, new-agent outreach fell from 549 a week to
// 9, and a manual sweep found it a week later.
//
//   AH-1  a daily key check (ghl-broker/key-health.js): one free, signed-in
//         read per provider, kept per key on the `keyHealth` cursor. A key a
//         provider rejects is a red line on Offers and Deals and an @Matt
//         line in #machine every day it stays rejected; so is Apify's month
//         past 80% of its usage limit.
//   AH-6  the failures that stop the business (a rejected key on a revenue
//         lane, a revenue job failing twice or stopped) @mention Matt, once a
//         day while they last. Counts and words only, never a contact.

export const KEY_HEALTH_CURSOR = "keyHealth";
// The stoppers the Slack runner last saw (ghl-broker/slack-notify.js), for
// the strip on Offers and Deals: a small cursor read on its own.
export const MACHINE_TROUBLE_CURSOR = "machineTrouble";

// The providers with a free signed-in read. RentCast, Tracerfy,
// RealEstateAPI and Bricked have none that isn't metered or a paid lookup,
// so they are left out rather than spending a request to check a key.
export const KEY_PROVIDERS = {
  apify: {
    label: "Zillow comps key (Apify)",
    stops: "auto-underwrite, the outreach listing check, price watch and the lot finder's builder scan",
  },
  anthropic: {
    label: "Claude key (Anthropic)",
    stops: "drafts, replies, underwrite reads and the nightly passes",
  },
};

export const APIFY_WARN_PCT = 80;
// The day's check, Pacific: from 7am, inside working hours.
export const KEY_HEALTH_HOUR = 7;
export const KEY_HEALTH_END_HOUR = 21;
// While a key is failing it is read again every hour, so a fixed key clears
// the same day (and the underwrites it stopped can be retried).
export const KEY_RECHECK_MS = 60 * 60000;
export const KEY_RETRY_GAP_MS = 20 * 60000;
export const KEY_STALE_RUN_MS = 10 * 60000;
export const KEY_MAX_DAILY_TRIES = 16;

// A provider saying the key itself is no good (or out of money), not a
// network wobble. Read from an HTTP status or an error's words.
export const AUTH_FAILURE = /\b40[123]\b|unauthori[sz]ed|forbidden|authentication[_ ]error|invalid[_ ]?(api[_ ]?)?key|payment required|out of credits/i;
export const AUTH_STATUSES = new Set([401, 402, 403]);

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const iso = (t) => new Date(t).toISOString();
const PT_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
const PT_WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" });
export const ptDay = (t) => PT_DAY.format(new Date(t));

/** normalizeKeyHealth(v) → { enabled } — settings.keyHealth; off unless saved true. */
export function normalizeKeyHealth(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  return { enabled: o.enabled === true };
}

/**
 * keyHealthDue(doc, { now, hourNow }) → { go, tries, stale, why }
 *
 * The check's gate, on its cursor: the day's first read from 7am Pacific; a
 * run that died (no finish after KEY_STALE_RUN_MS) or threw, again after
 * KEY_RETRY_GAP_MS; and while any key is failing, again every hour. Never
 * more than KEY_MAX_DAILY_TRIES a day.
 */
export function keyHealthDue(doc = {}, { now = Date.now(), hourNow = null } = {}) {
  const d = doc && typeof doc === "object" ? doc : {};
  const day = ptDay(now);
  const tries = d.day === day ? Number(d.tries) || 0 : 0;
  const no = (why) => ({ go: false, tries, stale: false, why });
  if (!(hourNow >= KEY_HEALTH_HOUR && hourNow < KEY_HEALTH_END_HOUR)) return no("outside its hours");
  if (tries >= KEY_MAX_DAILY_TRIES) return no(`${KEY_MAX_DAILY_TRIES} tries today`);
  const started = ms(d.run?.startedAt);
  const stale = started != null && now - started > KEY_STALE_RUN_MS;
  if (started != null && !stale) return no("a run is going");
  const go = { go: true, tries: tries + 1, stale, why: "" };
  if (d.day !== day) return go;
  const last = ms(d.lastRun) ?? 0;
  if ((stale || d.failed) && now - last >= KEY_RETRY_GAP_MS) return go;
  const failing = Object.values(d.keys || {}).some((k) => k?.ok === false);
  if (failing && now - last >= KEY_RECHECK_MS) return go;
  return no("checked today");
}

/** apifyUsage(json) → { usd, limitUsd, pct } | null — from GET /v2/users/me/limits. */
export function apifyUsage(json = {}) {
  const d = json?.data || {};
  const usd = Number(d.current?.monthlyUsageUsd);
  const limitUsd = Number(d.limits?.maxMonthlyUsageUsd);
  if (!Number.isFinite(usd) || !(limitUsd > 0)) return null;
  return { usd: Math.round(usd * 100) / 100, limitUsd: Math.round(limitUsd * 100) / 100, pct: Math.round((usd / limitUsd) * 100) };
}

/**
 * keyEntry(prev, probe, now) → the cursor's row for one key
 *
 * probe: { ok: true } | { ok: false, status, error } (the provider said no)
 *        | { ok: null, status, error } (no answer: kept, not called failing)
 *        | { skipped: "no key saved" }
 * `failingSince` holds across reads while the key stays rejected.
 */
export function keyEntry(prev = null, probe = {}, now = Date.now()) {
  const at = iso(now);
  if (probe?.skipped) return { ok: null, skipped: String(probe.skipped).slice(0, 80), checkedAt: at };
  const ok = probe?.ok === true ? true : probe?.ok === false ? false : null;
  return {
    ok,
    status: Number(probe?.status) || null,
    error: ok === true ? "" : String(probe?.error || "").slice(0, 160),
    checkedAt: at,
    failingSince: ok === false ? (prev?.ok === false && prev.failingSince ? prev.failingSince : at) : null,
    ...(probe?.usage ? { usage: probe.usage } : {}),
  };
}

/** probeVerdict(status, error) → true | false | null — rejected only on 401/402/403 or auth words. */
export function probeVerdict(status, error = "") {
  if (status >= 200 && status < 300) return true;
  if (AUTH_STATUSES.has(Number(status)) || (!status && AUTH_FAILURE.test(String(error)))) return false;
  return null;
}

/** providerHealthy(keyHealthDoc, provider) → true only when the last read of that key came back good. */
export function providerHealthy(doc = {}, provider = "") {
  return doc?.keys?.[provider]?.ok === true;
}

const sinceWord = (since, now) => {
  const t = ms(since);
  if (t == null) return "";
  if (ptDay(t) === ptDay(now)) return " since today";
  return ` since ${PT_WEEKDAY.format(new Date(t))}`;
};

/**
 * keyTroubles(doc, { now }) → [{ id, provider, kind, since, text }]
 *
 * What's wrong with the keys, in Matt's words: a key its provider rejects,
 * and Apify's month past APIFY_WARN_PCT of its limit. A read that got no
 * answer isn't a trouble; nor is a key that was never saved.
 */
export function keyTroubles(doc = {}, { now = Date.now() } = {}) {
  const out = [];
  for (const [provider, p] of Object.entries(KEY_PROVIDERS)) {
    const k = doc?.keys?.[provider];
    if (!k) continue;
    if (k.ok === false) {
      const status = k.status ? ` (HTTP ${k.status})` : "";
      out.push({ id: `key:${provider}`, provider, kind: "key", since: k.failingSince || k.checkedAt || null,
        text: `${p.label} rejected${sinceWord(k.failingSince, now)}${status}: ${p.stops} are stopped.` });
    }
    const u = k.usage;
    if (u && u.pct >= APIFY_WARN_PCT) {
      out.push({ id: `usage:${provider}`, provider, kind: "usage", since: k.checkedAt || null,
        text: `Apify usage is at ${u.pct}% of its $${u.limitUsd} monthly limit ($${u.usd}); at 100% ${p.stops} stop.` });
    }
  }
  return out;
}

/* ---------- the failures that stop the business (AH-6) ---------- */

// The lanes that bring in houses, agents and buyers. An auth failure in one
// of these, or one of these jobs failing twice or stopping, is a stopper.
export const STOPPER_AREAS = new Set([
  "underwrite", "tier-one-underwrite", "underwrite-queue", "outreach", "lot-finder", "price-watch", "delivery-watch",
  "follow-up", "agent-pulse", "buyer-pulse", "gatekeepers", "dispo-waves",
]);
export const STOPPER_JOBS = new Set(["outreach", "followUp", "agentPulse", "buyerPulse", "priceWatch", "deliveryWatch", "lotFinder", "gatekeepers", "dispo", "uwQueue"]);

/** errorIsStopper(appError) → an auth failure in a revenue lane (a tick job's `tick:<area>` counts). */
export function errorIsStopper(e = {}) {
  const area = String(e?.area || "").replace(/^tick:/, "");
  return STOPPER_AREAS.has(area) && AUTH_FAILURE.test(String(e?.message || ""));
}

/**
 * jobIsStopper(job, switches) → a switched-on revenue job (shared/line.js
 * lineJobs row) that stopped running, or failed on a rejected key, or failed
 * twice today.
 */
export function jobIsStopper(j = {}, switches = {}) {
  if (!STOPPER_JOBS.has(j?.name) || switches?.[j.name] !== true) return false;
  if (j.late) return true;
  return Boolean(j.failed) && (Number(j.tries) >= 2 || AUTH_FAILURE.test(String(j.error || "")));
}

/** stopperText(kind, row) → the one line for the strip: a job or an error, no contact. */
export function stopperText(kind, r = {}) {
  if (kind === "job") {
    return r.late
      ? `${r.label || r.name} hasn't run${r.hoursAgo != null ? ` in ${r.hoursAgo}h` : ""}.`
      : `${r.label || r.name} failed${Number(r.tries) > 1 ? ` ${r.tries} times today` : ""}${r.error ? `: ${String(r.error).slice(0, 120)}` : "."}`;
  }
  return `Errors in ${String(r.area || "the app").replace(/^tick:/, "")}: ${String(r.message || "").slice(0, 120)}`;
}

/**
 * machineTrouble({ keyHealth, stoppers, now }) → [{ id, text, since }]
 *
 * The strip's lines: the keys first, then the stoppers the Slack runner last
 * saw — dropped once that read is over an hour old (Slack off, or stopped),
 * so a stale line never sits there.
 */
export function machineTrouble({ keyHealth = null, stoppers = null, now = Date.now() } = {}) {
  const keys = keyTroubles(keyHealth?.doc || keyHealth || {}, { now }).map(({ id, text, since }) => ({ id, text, since }));
  const s = stoppers?.doc || stoppers || {};
  const fresh = ms(s.at) != null && now - ms(s.at) <= 60 * 60000;
  const more = fresh ? (s.stoppers || []).filter((x) => x?.id && x.text).map(({ id, text, since }) => ({ id, text: String(text).slice(0, 200), since: since || null })) : [];
  return [...keys, ...more].slice(0, 6);
}
