// home-config.js — the config contract for the consolidated Home page.
//
// Every Home queue is a CONTACT QUERY: a driving tag (membership) plus contact
// custom fields (the row data) — no pipelines, no opportunities. This module is
// the single place that names those tags and field keys so the UI, the queue
// endpoints, and the GHL snapshot checklist all agree.
//
// Resolution rules (enforced in routes/home.js):
//   • Custom fields are resolved by their logical KEY at runtime (GHL fieldKey
//     minus the "contact." prefix). A missing REQUIRED field/tag is reported as
//     a config error in the section payload — it never throws.
//   • Tag names are matched case-insensitively.
//   • Location owners can override any name via a Custom Value (see CV_OVERRIDES)
//     without a code change, so a sub-account with different conventions still
//     works. Overrides are read once per request and merged over these defaults.

/* ------------------------------------------------------------------ *
 * Contact custom-field keys (the row data behind each queue)
 * ------------------------------------------------------------------ */
// `required` fields gate the row: a contact in the queue tag but missing a
// required field is surfaced as a per-row config warning, not hidden silently.
export const FIELD_KEYS = {
  quotes: {
    quote_amount:  { required: true,  type: "number", label: "Quote amount" },
    quote_date:    { required: false, type: "date",   label: "Quoted date" },
    quote_expiry:  { required: false, type: "date",   label: "Quote expires" },
    property_address: { required: false, type: "text", label: "Property address" },
  },
  reviews: {
    job_type:           { required: false, type: "text", label: "Job type" },
    job_completed_date: { required: true,  type: "date", label: "Job completed" },
    review_rating:      { required: false, type: "number", label: "Review rating" },
  },
  winback: {
    last_service_date: { required: true,  type: "date",   label: "Last service date" },
    last_service_type: { required: false, type: "text",   label: "Last service" },
    lifetime_value:    { required: false, type: "number", label: "Lifetime value" },
  },
  offers: {
    deal_count:        { required: true,  type: "number", label: "Deal count" },
    deal_volume:       { required: false, type: "number", label: "Deal volume" },
    deal_first_date:   { required: false, type: "date",   label: "First deal date" },
    late_payment_count:{ required: false, type: "number", label: "Late payments" },
    tier:              { required: false, type: "text",   label: "Tier override" },
  },
};

/* ------------------------------------------------------------------ *
 * Tags — membership, status, and send triggers
 * ------------------------------------------------------------------ */
export const TAGS = {
  quotes: {
    // A contact carrying this tag is IN the Quote Follow-Up queue.
    queue: "quote-open",
    // Status tags → reply badges. Absence of both = "awaiting" (age-based).
    status: { replied: "quote-replied", noReply: "quote-no-reply" },
    // Applying this tag fires the GHL "quote follow-up" workflow (MMS + card + sequence).
    trigger: "send-quote-followup",
  },
  reviews: {
    queue: "review-due",
    status: { left: "review-left", scheduled: "review-reminder-scheduled" },
    trigger: "send-review-request",
  },
  winback: {
    queue: "winback-due",
    status: {},
    trigger: "send-winback",
  },
  offers: {
    queue: "offer-eligible",
    status: {},
    trigger: "send-offer",
  },
};

/* ------------------------------------------------------------------ *
 * Offer tiers — earned by track record, terms are pluggable
 * ------------------------------------------------------------------ */
// A contact's tier is the highest tier whose rule matches their record. Terms
// are the numbers shown on the dark "terms card". `termsSource: "provider"`
// means the offer template's http-json data source supplies data.tier.* at
// render time (for higher-tier customers whose terms live in an external
// system); otherwise the terms below are injected into the render context.
export const DEFAULT_TIERS = [
  { id: "proven", label: "Proven", rule: { minDeals: 4 }, terms: { rate: "9.0%",  down: "10%" }, termsSource: "config" },
  { id: "repeat", label: "Repeat", rule: { minDeals: 2 }, terms: { rate: "9.75%", down: "10%" }, termsSource: "config" },
  { id: "new",    label: "New",    rule: { minDeals: 0 }, terms: { rate: "10.5%", down: "10%" }, termsSource: "config" },
];

// Assign a tier from a contact's resolved numeric record. An explicit
// `tier` field value (matching a tier id/label) always wins so a location can
// hand-place a contact. Returns the matched tier object (never null — the
// lowest-rule tier is the floor).
export function resolveTier(record, tiers = DEFAULT_TIERS) {
  const ordered = [...tiers].sort((a, b) => (b.rule?.minDeals ?? 0) - (a.rule?.minDeals ?? 0));
  const override = String(record?.tier || "").trim().toLowerCase();
  if (override) {
    const hit = ordered.find((t) => t.id.toLowerCase() === override || t.label.toLowerCase() === override);
    if (hit) return hit;
  }
  const deals = Number(record?.deal_count || 0);
  return ordered.find((t) => deals >= (t.rule?.minDeals ?? 0)) || ordered[ordered.length - 1];
}

/* ------------------------------------------------------------------ *
 * Per-section defaults (template name to resolve + outgoing message)
 * ------------------------------------------------------------------ */
// `templateName` is resolved to a real templateId at runtime (case-insensitive
// match against the location's Card Studio templates). Seed these names by
// creating templates with matching names (see the snapshot checklist).
export const SECTIONS = {
  quotes: {
    view: "quotes",
    label: "Quote follow-up",
    subtitle: "Open quotes, sorted by expiry",
    templateName: "Quote Follow-Up",
    message:
      "Hi {{contact.first_name}}, {{loc.owner_first_name}} here from {{loc.business_name}} — your quote for " +
      "{{contact.custom.property_address}} is ${{contact.custom.quote_amount}}, good through " +
      "{{contact.custom.quote_expiry}}. Want me to hold your spot on next week's schedule?",
    batch: false, // single-send section (one contact at a time)
  },
  reviews: {
    view: "reviews",
    label: "Reviews",
    subtitle: "Ask while the job is still fresh",
    templateName: "Review Request",
    message:
      "{{contact.first_name}}, thanks for trusting {{loc.business_name}} with your " +
      "{{contact.custom.job_type}}! If the crew earned it, a quick Google review helps us a ton: [Review Link]",
    batch: false,
  },
  winback: {
    view: "winback",
    label: "Win-back",
    subtitle: "Past customers going quiet — sorted by lifetime value",
    templateName: "Property Card",
    message:
      "Hi {{contact.first_name}}, {{loc.owner_first_name}} from {{loc.business_name}} — we handled your " +
      "{{contact.custom.last_service_type}} a while back and it's about due again. Want me to pencil you in " +
      "this month at your returning-customer rate?",
    batch: true, // batch-send section (audience strip + confirm)
  },
  offers: {
    view: "offers",
    label: "Offers",
    subtitle: "Existing customers, segmented by track record",
    templateName: "Offer Terms",
    message:
      "{{contact.first_name}} — you've done {{contact.custom.deal_count}} deals with us now, so your pricing " +
      "just changed. {{data.tier.rate}} and {{data.tier.down}} down on your next one, locked for 90 days. " +
      "Got anything in the works?",
    batch: true,
  },
};

export const SECTION_KEYS = Object.keys(SECTIONS);

/* ------------------------------------------------------------------ *
 * Custom Value override names (optional per-location config in GHL)
 * ------------------------------------------------------------------ */
// Read from the location's Custom Values; when present they override the code
// defaults above. Everything is optional — the defaults are a working baseline.
export const CV_OVERRIDES = {
  // Template name per section: rh_home_<section>_template
  templateName: (section) => `rh_home_${section}_template`,
  // Outgoing message per section: rh_home_<section>_message
  message: (section) => `rh_home_${section}_message`,
  // Tier definitions as JSON: rh_home_offer_tiers
  tiers: "rh_home_offer_tiers",
  // Hard batch cap override (else CAMPAIGN_CAP env): rh_home_batch_cap
  batchCap: "rh_home_batch_cap",
};

// Merge a { customValueName: value } map over the code defaults, producing the
// effective, resolved config for one section. Pure — no I/O.
export function effectiveSection(section, cvByName = {}) {
  const base = SECTIONS[section];
  if (!base) throw Object.assign(new Error(`unknown section "${section}"`), { http: 400 });
  const tName = cvByName[CV_OVERRIDES.templateName(section)];
  const msg = cvByName[CV_OVERRIDES.message(section)];
  return {
    ...base,
    templateName: (tName && String(tName).trim()) || base.templateName,
    message: (msg && String(msg).trim()) || base.message,
    fields: FIELD_KEYS[section],
    tags: TAGS[section],
  };
}

// Parse the tier-override JSON custom value; fall back to DEFAULT_TIERS on any
// problem (never throws — a malformed value must not break the Offers queue).
export function effectiveTiers(cvByName = {}) {
  const raw = cvByName[CV_OVERRIDES.tiers];
  if (!raw) return DEFAULT_TIERS;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed) && parsed.length && parsed.every((t) => t && t.id)) return parsed;
  } catch {
    /* ignore — malformed override */
  }
  return DEFAULT_TIERS;
}
