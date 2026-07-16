// config.js — the single source of truth for how the app's settings map to
// GoHighLevel Custom Values. The Messaging page speaks the left-hand names;
// GHL stores the right-hand names. Keep these names in sync with the merge
// fields you use inside the GHL workflow (e.g. {{custom_values.rh_business_name}}).

export const CV = {
  ownerName: "rh_owner_first_name",
  businessName: "rh_business_name",
  logoUrl: "rh_logo_url",
  personalizedImage: "rh_personalized_image",
  smartEnabled: "rh_smart_enabled",
  followUps: "rh_follow_ups",
  mode: "rh_message_mode", // "smart" | "custom"
  customTemplate: "rh_custom_template",
  reviewLink: "rh_review_link",
  cardFit: "rh_card_fit", // "cover" | "contain"
  cardBgColor: "rh_card_bg_color",
  cardHeadline: "rh_card_headline",
  cardAccent: "rh_card_accent",
  cardNameX: "rh_card_name_x", // 0..1 pill center, horizontal
  cardNameY: "rh_card_name_y", // 0..1 pill center, vertical
  // Brand kit — themes gallery templates + new cards in the Card Studio.
  brandBg: "rh_brand_bg",         // card background (dark neutrals remap here)
  brandAccent: "rh_brand_accent", // accent (golds/saturated colors remap here)
  brandText: "rh_brand_text",     // text (whites/light tones remap here)
  brandFont: "rh_brand_font",     // "Inter" | "Source Serif" | "Archivo Black"
  brandIndustry: "rh_brand_industry", // gallery default filter (e.g. "roofing")
};

const BOOL_FIELDS = new Set(["personalizedImage", "smartEnabled", "followUps"]);

// Turn an app config object -> { ghlCustomValueName: stringValue }
export function serializeConfig(config) {
  const out = {};
  for (const [field, cvName] of Object.entries(CV)) {
    if (config[field] === undefined) continue;
    let v = config[field];
    if (BOOL_FIELDS.has(field)) v = v ? "true" : "false";
    out[cvName] = String(v ?? "");
  }
  return out;
}

// Turn a { ghlCustomValueName: value } map -> app config object
export function deserializeConfig(byName) {
  const out = {};
  for (const [field, cvName] of Object.entries(CV)) {
    if (!(cvName in byName)) continue;
    let v = byName[cvName];
    if (BOOL_FIELDS.has(field)) v = v === "true" || v === true;
    out[field] = v;
  }
  return out;
}
