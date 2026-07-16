// starters.js — starter/seed template factories, shared by the editor ("New
// from starter") and the broker (first-load seeding + legacy migration). Pure
// data; no zod (the broker validates on save). Coordinates are percent.

let _n = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}${(_n++).toString(36)}`;

// Review Request — a faithful port of the legacy hardcoded card:
//   logo image (cover/contain) + optional headline + white name pill.
// Accepts legacy saved settings so migration reuses this exact builder.
export function reviewRequestStarter({
  locationId,
  logoUrl = "",
  cardFit = "cover",
  cardBgColor = "#0b0b0c",
  cardHeadline = "",
  cardAccent = "#ffffff",
  cardNameX = 0.5,
  cardNameY = 0.7,
} = {}) {
  const nameW = 60, nameH = 12;
  const layers = [];

  if (logoUrl) {
    layers.push({ id: uid("img"), type: "image", x: 0, y: 0, width: 100, height: 100, src: logoUrl, fit: cardFit === "contain" ? "contain" : "cover", cornerRadius: 0, opacity: 1, visible: true });
  }
  // Readability scrim over the lower half (approximates the legacy gradient).
  layers.push({ id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 45, width: 100, height: 55, fill: "rgba(0,0,0,0.4)", cornerRadius: 0, opacity: 1, visible: true });

  if (cardHeadline) {
    layers.push({ id: uid("hl"), type: "text", x: 8, y: 22, width: 84, height: 12, content: cardHeadline, fontFamily: "Inter", fontWeight: "bold", fontSize: 54, color: cardAccent, align: "center", lineHeight: 1.15, autoFit: true, maxLines: 2, visible: true });
  }

  // Name pill centred on the legacy (nameX, nameY) fractions.
  layers.push({
    id: uid("name"), type: "name-box",
    x: clamp(cardNameX * 100 - nameW / 2, 0, 100 - nameW),
    y: clamp(cardNameY * 100 - nameH / 2, 0, 100 - nameH),
    width: nameW, height: nameH,
    content: "{{contact.first_name}}!", bgColor: "#ffffff", textColor: "#0b0b0c",
    fontFamily: "Inter", fontSize: 92, paddingX: 54, paddingY: 0, cornerRadius: 999, visible: true,
  });

  return {
    locationId,
    name: "Review Request",
    canvas: { width: 1080, height: 1080 },
    background: { color: safeHex(cardBgColor, "#0b0b0c") },
    dataSources: [],
    layers,
    sampleData: {
      "contact.first_name": "Jessica",
      "loc.business_name": "PRVT MKT",
    },
  };
}

// Property Card — a satellite parcel map with the address + lot-size badge.
export function propertyCardStarter({ locationId } = {}) {
  return {
    locationId,
    name: "Property Card",
    canvas: { width: 1080, height: 1080 },
    background: { color: "#0b0b0c" },
    dataSources: [
      {
        id: "parcel",
        provider: "mapbox-parcel",
        inputs: { address: "{{contact.custom.property_address}}" },
        options: { county: "king-wa", mapStyle: "satellite-v9", parcelColor: "#d4af37", showBuilding: false, padding: 40 },
        connectionId: "",
        discoveredKeys: ["apn", "lot_sqft", "address"],
        thumbnailUrl: "",
      },
    ],
    layers: [
      { id: uid("dimg"), type: "dynamic-image", sourceId: "parcel", x: 0, y: 0, width: 100, height: 100, fit: "cover", visible: true },
      { id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 60, width: 100, height: 40, fill: "rgba(0,0,0,0.55)", cornerRadius: 0, visible: true },
      { id: uid("addr"), type: "text", x: 6, y: 64, width: 88, height: 12, content: "{{contact.custom.property_address}}", fontFamily: "Inter", fontWeight: "bold", fontSize: 46, color: "#ffffff", align: "center", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("name"), type: "name-box", x: 30, y: 78, width: 40, height: 10, content: "{{contact.first_name}}!", bgColor: "#ffffff", textColor: "#0b0b0c", fontFamily: "Inter", fontSize: 64, paddingX: 44, paddingY: 0, cornerRadius: 999, visible: true },
      { id: uid("badge"), type: "badge", x: 30, y: 90, width: 40, height: 7, icon: "pin", text: "{{data.parcel.lot_sqft}} sq ft lot", bgColor: "#d4af37", textColor: "#0b0b0c", fontFamily: "Inter", fontSize: 34, cornerRadius: 999, visible: true },
    ],
    sampleData: {
      "contact.first_name": "Jessica",
      "contact.custom.property_address": "1600 Pennsylvania Ave, Seattle, WA",
      "data.parcel.lot_sqft": "7200",
    },
  };
}

// Thank You / Job Complete — photo background, scrim, big display text, star badge.
export function thankYouStarter({ locationId } = {}) {
  return {
    locationId,
    name: "Thank You",
    canvas: { width: 1080, height: 1080 },
    background: { color: "#111827" },
    dataSources: [],
    layers: [
      { id: uid("photo"), type: "image", x: 0, y: 0, width: 100, height: 100, src: "", fit: "cover", cornerRadius: 0, visible: true },
      { id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 0, width: 100, height: 100, fill: "rgba(0,0,0,0.45)", cornerRadius: 0, visible: true },
      { id: uid("big"), type: "text", x: 8, y: 34, width: 84, height: 30, content: "Thanks, {{contact.first_name}}!", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 130, color: "#ffffff", align: "center", lineHeight: 1.0, autoFit: true, maxLines: 2, visible: true },
      { id: uid("badge"), type: "badge", x: 35, y: 70, width: 30, height: 7, icon: "star", text: "5-star service", bgColor: "#f59e0b", textColor: "#0b0b0c", fontFamily: "Inter", fontSize: 34, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica" },
  };
}

/* ------------------------------------------------------------------ *
 * Niche presets — each ships matching message copy + a complete design
 * so the preview reads clearly on selection.
 * ------------------------------------------------------------------ */

const SQUARE = { width: 1080, height: 1080 };
// Stable Unsplash direct images (user swaps for their own). Public https so
// cardgen can fetch them at render time.
const IMG = {
  house: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1080&h=1080&q=80",
  service: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1080&h=1080&q=80",
  // Editor/gallery thumbnails for dynamic-image layers (the REAL imagery is
  // fetched per contact at render time; these just make previews representative).
  thumbAerial: "https://images.unsplash.com/photo-1449844908441-8829872d2607?auto=format&fit=crop&w=640&h=640&q=70",
  thumbSatellite: "https://images.unsplash.com/photo-1446776877081-d282a0f896e2?auto=format&fit=crop&w=640&h=640&q=70",
  thumbStreet: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=640&h=640&q=70",
};

// Real estate — Just Listed (photo + details).
export function justListedStarter({ locationId } = {}) {
  return {
    locationId, name: "Just Listed", canvas: SQUARE, background: { color: "#0f172a" }, dataSources: [],
    layers: [
      { id: uid("img"), type: "image", x: 0, y: 0, width: 100, height: 100, src: IMG.house, fit: "cover", visible: true },
      { id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 52, width: 100, height: 48, fill: "rgba(15,23,42,0.72)", visible: true },
      { id: uid("kick"), type: "text", x: 7, y: 56, width: 86, height: 7, content: "JUST LISTED", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 46, color: "#d4af37", align: "left", visible: true },
      { id: uid("addr"), type: "text", x: 7, y: 65, width: 86, height: 12, content: "{{contact.custom.property_address}}", fontFamily: "Inter", fontWeight: "bold", fontSize: 46, color: "#ffffff", align: "left", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("badge"), type: "badge", x: 7, y: 84, width: 60, height: 8, icon: "pin", text: "3 bd · 2 ba · 1,800 sqft", bgColor: "#d4af37", textColor: "#0f172a", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica", "contact.custom.property_address": "1943 8th Ave W, Seattle, WA", "loc.business_name": "Goldstar Realty" },
  };
}

// Real estate — Home Value (typographic).
export function homeValueStarter({ locationId } = {}) {
  return {
    locationId, name: "Home Value", canvas: SQUARE, background: { color: "#0f172a" }, dataSources: [],
    layers: [
      { id: uid("bar"), type: "shape", shape: "rect", x: 8, y: 20, width: 16, height: 1.4, fill: "#d4af37", visible: true },
      { id: uid("h"), type: "text", x: 8, y: 26, width: 84, height: 30, content: "What's your home worth?", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 96, color: "#ffffff", align: "left", lineHeight: 1.02, autoFit: true, maxLines: 3, visible: true },
      { id: uid("addr"), type: "text", x: 8, y: 62, width: 84, height: 9, content: "{{contact.custom.property_address}}", fontFamily: "Inter", fontWeight: "bold", fontSize: 42, color: "#d4af37", align: "left", autoFit: true, maxLines: 1, visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 76, width: 62, height: 8, icon: "check", text: "Free, no-obligation valuation", bgColor: "#d4af37", textColor: "#0f172a", fontFamily: "Inter", fontSize: 30, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica", "contact.custom.property_address": "1943 8th Ave W, Seattle, WA", "loc.business_name": "Goldstar Realty" },
  };
}

// Services — Special / Promo (bold).
export function serviceSpecialStarter({ locationId } = {}) {
  return {
    locationId, name: "Service Special", canvas: SQUARE, background: { color: "#b45309" }, dataSources: [],
    layers: [
      { id: uid("k"), type: "text", x: 8, y: 16, width: 84, height: 6, content: "LIMITED-TIME OFFER", fontFamily: "Inter", fontWeight: "bold", fontSize: 34, color: "#fde68a", align: "left", visible: true },
      { id: uid("big"), type: "text", x: 6, y: 24, width: 88, height: 30, content: "20% OFF", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 240, color: "#ffffff", align: "left", autoFit: true, maxLines: 1, visible: true },
      { id: uid("biz"), type: "text", x: 8, y: 58, width: 84, height: 9, content: "{{loc.business_name}}", fontFamily: "Inter", fontWeight: "bold", fontSize: 48, color: "#ffffff", align: "left", autoFit: true, maxLines: 1, visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 74, width: 60, height: 8, text: "Book by Friday →", bgColor: "#ffffff", textColor: "#b45309", fontFamily: "Inter", fontSize: 34, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica", "loc.business_name": "Goldstar Plumbing" },
  };
}

// Services — Appointment Reminder (clean).
export function appointmentReminderStarter({ locationId } = {}) {
  return {
    locationId, name: "Appointment Reminder", canvas: SQUARE, background: { color: "#1d4ed8" }, dataSources: [],
    layers: [
      { id: uid("h"), type: "text", x: 8, y: 26, width: 84, height: 22, content: "You're all set, {{contact.first_name}}!", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 100, color: "#ffffff", align: "left", lineHeight: 1.05, autoFit: true, maxLines: 3, visible: true },
      { id: uid("sub"), type: "text", x: 8, y: 56, width: 82, height: 14, content: "We'll see you soon. Save our number so you never miss an update.", fontFamily: "Inter", fontWeight: "regular", fontSize: 40, color: "#dbeafe", align: "left", lineHeight: 1.2, autoFit: true, maxLines: 3, visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 78, width: 55, height: 8, icon: "phone", text: "Questions? Just reply", bgColor: "#ffffff", textColor: "#1d4ed8", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica", "loc.business_name": "Goldstar Services" },
  };
}

// General — Welcome / New customer.
export function welcomeStarter({ locationId } = {}) {
  return {
    locationId, name: "Welcome", canvas: SQUARE, background: { color: "#15803d" }, dataSources: [],
    layers: [
      { id: uid("h"), type: "text", x: 8, y: 24, width: 84, height: 26, content: "Welcome, {{contact.first_name}}!", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 120, color: "#ffffff", align: "left", lineHeight: 1.02, autoFit: true, maxLines: 3, visible: true },
      { id: uid("sub"), type: "text", x: 8, y: 58, width: 84, height: 10, content: "Thanks for choosing {{loc.business_name}}.", fontFamily: "Inter", fontWeight: "bold", fontSize: 44, color: "#dcfce7", align: "left", autoFit: true, maxLines: 2, visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 76, width: 55, height: 8, icon: "star", text: "We're glad you're here", bgColor: "#ffffff", textColor: "#15803d", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica", "loc.business_name": "Goldstar Co." },
  };
}

/* ------------------------------------------------------------------ *
 * Home-page starters — the templates the consolidated Home screen
 * resolves by name (see ghl-broker/home-config.js SECTIONS).
 * ------------------------------------------------------------------ */

// Quote Follow-Up — parcel aerial + the quote figures. The Home Quotes queue
// binds quote_amount / quote_expiry / property_address contact fields.
export function quoteFollowUpStarter({ locationId } = {}) {
  return {
    locationId,
    name: "Quote Follow-Up",
    canvas: { width: 1080, height: 1080 },
    background: { color: "#0b0b0c" },
    dataSources: [
      {
        id: "parcel",
        provider: "mapbox-parcel",
        inputs: { address: "{{contact.custom.property_address}}" },
        options: { county: "king-wa", mapStyle: "satellite-v9", parcelColor: "#d4af37", showBuilding: false, padding: 40 },
        connectionId: "",
        discoveredKeys: ["apn", "lot_sqft", "address"],
        thumbnailUrl: "",
      },
    ],
    layers: [
      { id: uid("dimg"), type: "dynamic-image", sourceId: "parcel", x: 0, y: 0, width: 100, height: 100, fit: "cover", visible: true },
      { id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 58, width: 100, height: 42, fill: "rgba(0,0,0,0.6)", cornerRadius: 0, visible: true },
      { id: uid("addr"), type: "text", x: 6, y: 62, width: 88, height: 8, content: "{{contact.custom.property_address}}", fontFamily: "Inter", fontWeight: "bold", fontSize: 42, color: "#ffffff", align: "center", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("quote"), type: "text", x: 6, y: 72, width: 88, height: 10, content: "{{contact.first_name}} — your quote: ${{contact.custom.quote_amount}}", fontFamily: "Inter", fontWeight: "bold", fontSize: 52, color: "#d4af37", align: "center", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("badge"), type: "badge", x: 25, y: 86, width: 50, height: 7, icon: "check", text: "Good through {{contact.custom.quote_expiry}}", bgColor: "#ffffff", textColor: "#0b0b0c", fontFamily: "Inter", fontSize: 30, cornerRadius: 999, visible: true },
    ],
    sampleData: {
      "contact.first_name": "Dana",
      "contact.custom.property_address": "2847 41st Ave SW, Seattle, WA",
      "contact.custom.quote_amount": "14,200",
      "contact.custom.quote_expiry": "Jul 15",
    },
  };
}

// Offer Terms — the dark per-tier terms card: headline → two big earned numbers
// → proof line → expiry. data.tier.* is injected by the broker per contact
// (or by an http-json data source with id "tier" for external terms).
export function offerTermsStarter({ locationId } = {}) {
  return {
    locationId,
    name: "Offer Terms",
    canvas: { width: 1080, height: 1080 },
    background: { color: "#0f172a" },
    dataSources: [],
    layers: [
      { id: uid("h"), type: "text", x: 8, y: 10, width: 84, height: 12, content: "{{contact.first_name}}, you earned better terms", fontFamily: "Inter", fontWeight: "bold", fontSize: 60, color: "#ffffff", align: "left", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("l1"), type: "text", x: 8, y: 30, width: 38, height: 5, content: "YOUR RATE", fontFamily: "Inter", fontWeight: "regular", fontSize: 30, color: "#94a3b8", align: "left", visible: true },
      { id: uid("l2"), type: "text", x: 54, y: 30, width: 38, height: 5, content: "DOWN", fontFamily: "Inter", fontWeight: "regular", fontSize: 30, color: "#94a3b8", align: "left", visible: true },
      { id: uid("b1"), type: "text", x: 8, y: 36, width: 42, height: 15, content: "{{data.tier.rate}}", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 140, color: "#d4af37", align: "left", autoFit: true, maxLines: 1, visible: true },
      { id: uid("b2"), type: "text", x: 54, y: 36, width: 38, height: 15, content: "{{data.tier.down}}", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 140, color: "#ffffff", align: "left", autoFit: true, maxLines: 1, visible: true },
      { id: uid("rule"), type: "shape", shape: "rect", x: 8, y: 57, width: 84, height: 0.4, fill: "rgba(148,163,184,0.35)", cornerRadius: 0, visible: true },
      { id: uid("proof"), type: "text", x: 8, y: 61, width: 84, height: 6, content: "Based on {{data.tier.proof}}", fontFamily: "Inter", fontWeight: "regular", fontSize: 36, color: "#cbd5e1", align: "left", autoFit: true, maxLines: 2, visible: true },
      { id: uid("lock"), type: "text", x: 8, y: 68, width: 84, height: 5, content: "Locked for 90 days", fontFamily: "Inter", fontWeight: "regular", fontSize: 30, color: "#64748b", align: "left", visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 82, width: 52, height: 8, icon: "star", text: "{{data.tier.label}} client pricing", bgColor: "#d4af37", textColor: "#0f172a", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: {
      "contact.first_name": "Matt",
      "data.tier.rate": "9.0%",
      "data.tier.down": "10%",
      "data.tier.label": "Proven",
      "data.tier.proof": "4 deals · $1.2M · 0 late payments",
    },
  };
}

/* ------------------------------------------------------------------ *
 * Gallery starters — additional premade designs per purpose/industry.
 * ------------------------------------------------------------------ */

// Blank canvas — the "start from scratch" tile.
export function blankStarter({ locationId } = {}) {
  return {
    locationId, name: "Untitled card", canvas: SQUARE, background: { color: "#0b0b0c" },
    dataSources: [], layers: [],
    sampleData: { "contact.first_name": "Jessica", "loc.business_name": "Your Business" },
  };
}

// Quotes — deadline-driven typographic card (any industry).
export function quoteExpiringStarter({ locationId } = {}) {
  return {
    locationId, name: "Quote Expiring", canvas: SQUARE, background: { color: "#7c2d12" }, dataSources: [],
    layers: [
      { id: uid("k"), type: "text", x: 8, y: 14, width: 84, height: 6, content: "DON'T LOSE YOUR PRICE", fontFamily: "Inter", fontWeight: "bold", fontSize: 34, color: "#fdba74", align: "left", visible: true },
      { id: uid("big"), type: "text", x: 8, y: 22, width: 84, height: 26, content: "${{contact.custom.quote_amount}}", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 210, color: "#ffffff", align: "left", autoFit: true, maxLines: 1, visible: true },
      { id: uid("sub"), type: "text", x: 8, y: 52, width: 84, height: 12, content: "{{contact.first_name}}, your quote is locked in until {{contact.custom.quote_expiry}}.", fontFamily: "Inter", fontWeight: "regular", fontSize: 44, color: "#fed7aa", align: "left", lineHeight: 1.2, autoFit: true, maxLines: 3, visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 76, width: 58, height: 8, icon: "check", text: "Reply YES to lock your spot", bgColor: "#ffffff", textColor: "#7c2d12", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Dana", "contact.custom.quote_amount": "14,200", "contact.custom.quote_expiry": "Jul 15" },
  };
}

// Quotes — roofing-themed quote card.
export function roofQuoteStarter({ locationId } = {}) {
  return {
    locationId, name: "Roof Quote", canvas: SQUARE, background: { color: "#1e293b" }, dataSources: [],
    layers: [
      { id: uid("bar"), type: "shape", shape: "rect", x: 8, y: 16, width: 14, height: 1.2, fill: "#d4af37", visible: true },
      { id: uid("h"), type: "text", x: 8, y: 21, width: 84, height: 20, content: "Your new roof, {{contact.first_name}}", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 92, color: "#ffffff", align: "left", lineHeight: 1.05, autoFit: true, maxLines: 2, visible: true },
      { id: uid("amt"), type: "text", x: 8, y: 46, width: 84, height: 16, content: "${{contact.custom.quote_amount}}", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 150, color: "#d4af37", align: "left", autoFit: true, maxLines: 1, visible: true },
      { id: uid("addr"), type: "text", x: 8, y: 66, width: 84, height: 7, content: "{{contact.custom.property_address}}", fontFamily: "Inter", fontWeight: "regular", fontSize: 36, color: "#94a3b8", align: "left", autoFit: true, maxLines: 1, visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 78, width: 62, height: 8, icon: "check", text: "Good through {{contact.custom.quote_expiry}}", bgColor: "#d4af37", textColor: "#1e293b", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Dana", "contact.custom.quote_amount": "14,200", "contact.custom.property_address": "2847 41st Ave SW", "contact.custom.quote_expiry": "Jul 15" },
  };
}

// Reviews — big five-star ask (any industry).
export function fiveStarAskStarter({ locationId } = {}) {
  return {
    locationId, name: "Five-Star Ask", canvas: SQUARE, background: { color: "#111827" }, dataSources: [],
    layers: [
      { id: uid("stars"), type: "text", x: 8, y: 22, width: 84, height: 12, content: "★ ★ ★ ★ ★", fontFamily: "Inter", fontWeight: "bold", fontSize: 110, color: "#f59e0b", align: "center", autoFit: true, maxLines: 1, visible: true },
      { id: uid("h"), type: "text", x: 8, y: 40, width: 84, height: 20, content: "How did we do, {{contact.first_name}}?", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 96, color: "#ffffff", align: "center", lineHeight: 1.05, autoFit: true, maxLines: 2, visible: true },
      { id: uid("sub"), type: "text", x: 12, y: 64, width: 76, height: 8, content: "A quick review helps {{loc.business_name}} a ton.", fontFamily: "Inter", fontWeight: "regular", fontSize: 38, color: "#9ca3af", align: "center", autoFit: true, maxLines: 2, visible: true },
      { id: uid("badge"), type: "badge", x: 27, y: 80, width: 46, height: 8, icon: "star", text: "Tap the link to review", bgColor: "#f59e0b", textColor: "#111827", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Luis", "loc.business_name": "Rainier Roofing" },
  };
}

// Reviews — job-complete photo card for home services.
export function jobDoneReviewStarter({ locationId } = {}) {
  return {
    locationId, name: "Job Done — Review", canvas: SQUARE, background: { color: "#0b0b0c" }, dataSources: [],
    layers: [
      { id: uid("photo"), type: "image", x: 0, y: 0, width: 100, height: 100, src: IMG.service, fit: "cover", visible: true },
      { id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 52, width: 100, height: 48, fill: "rgba(0,0,0,0.62)", visible: true },
      { id: uid("h"), type: "text", x: 6, y: 57, width: 88, height: 12, content: "{{contact.first_name}}, your {{contact.custom.job_type}} is done!", fontFamily: "Inter", fontWeight: "bold", fontSize: 54, color: "#ffffff", align: "center", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("stars"), type: "text", x: 8, y: 72, width: 84, height: 8, content: "★ ★ ★ ★ ★  How did the crew do?", fontFamily: "Inter", fontWeight: "bold", fontSize: 40, color: "#f59e0b", align: "center", autoFit: true, maxLines: 1, visible: true },
    ],
    sampleData: { "contact.first_name": "Luis", "contact.custom.job_type": "gutter replacement" },
  };
}

// Win-back — "time for another" typographic (services).
export function timeForAnotherStarter({ locationId } = {}) {
  return {
    locationId, name: "Time For Another", canvas: SQUARE, background: { color: "#134e4a" }, dataSources: [],
    layers: [
      { id: uid("k"), type: "text", x: 8, y: 16, width: 84, height: 6, content: "IT'S BEEN A WHILE", fontFamily: "Inter", fontWeight: "bold", fontSize: 34, color: "#5eead4", align: "left", visible: true },
      { id: uid("h"), type: "text", x: 8, y: 24, width: 84, height: 26, content: "Time for another {{contact.custom.last_service_type}}, {{contact.first_name}}?", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 92, color: "#ffffff", align: "left", lineHeight: 1.05, autoFit: true, maxLines: 3, visible: true },
      { id: uid("sub"), type: "text", x: 8, y: 58, width: 84, height: 10, content: "We'll pencil you in at your returning-customer rate.", fontFamily: "Inter", fontWeight: "regular", fontSize: 40, color: "#99f6e4", align: "left", lineHeight: 1.2, autoFit: true, maxLines: 2, visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 78, width: 52, height: 8, icon: "phone", text: "Reply to book this month", bgColor: "#5eead4", textColor: "#134e4a", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Priya", "contact.custom.last_service_type": "roof cleaning" },
  };
}

// Win-back — seasonal hook (roofing / exterior services).
export function seasonDueStarter({ locationId } = {}) {
  return {
    locationId, name: "Season Due", canvas: SQUARE, background: { color: "#14532d" }, dataSources: [],
    layers: [
      { id: uid("h"), type: "text", x: 8, y: 20, width: 84, height: 24, content: "Moss season is back, {{contact.first_name}}", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 100, color: "#ffffff", align: "left", lineHeight: 1.05, autoFit: true, maxLines: 3, visible: true },
      { id: uid("sub"), type: "text", x: 8, y: 52, width: 84, height: 12, content: "Your roof was last treated {{contact.custom.last_service_date}} — it's about due again.", fontFamily: "Inter", fontWeight: "regular", fontSize: 40, color: "#bbf7d0", align: "left", lineHeight: 1.2, autoFit: true, maxLines: 3, visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 78, width: 58, height: 8, icon: "check", text: "Returning-customer rate inside", bgColor: "#ffffff", textColor: "#14532d", fontFamily: "Inter", fontSize: 30, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Priya", "contact.custom.last_service_date": "April 2025" },
  };
}

// Offers — loyalty percentage reward (services).
export function loyaltyOfferStarter({ locationId } = {}) {
  return {
    locationId, name: "Loyalty Offer", canvas: SQUARE, background: { color: "#312e81" }, dataSources: [],
    layers: [
      { id: uid("k"), type: "text", x: 8, y: 14, width: 84, height: 6, content: "FOR OUR BEST CUSTOMERS", fontFamily: "Inter", fontWeight: "bold", fontSize: 32, color: "#a5b4fc", align: "left", visible: true },
      { id: uid("big"), type: "text", x: 6, y: 22, width: 88, height: 28, content: "15% OFF", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 230, color: "#ffffff", align: "left", autoFit: true, maxLines: 1, visible: true },
      { id: uid("sub"), type: "text", x: 8, y: 54, width: 84, height: 12, content: "{{contact.first_name}} — {{contact.custom.deal_count}} jobs with us earns you member pricing on the next one.", fontFamily: "Inter", fontWeight: "regular", fontSize: 40, color: "#c7d2fe", align: "left", lineHeight: 1.2, autoFit: true, maxLines: 3, visible: true },
      { id: uid("badge"), type: "badge", x: 8, y: 78, width: 52, height: 8, icon: "star", text: "{{data.tier.label}} member", bgColor: "#a5b4fc", textColor: "#312e81", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Matt", "contact.custom.deal_count": "4", "data.tier.label": "Proven" },
  };
}

// Offers — bold comeback credit (any industry).
export function comebackCreditStarter({ locationId } = {}) {
  return {
    locationId, name: "Comeback Credit", canvas: SQUARE, background: { color: "#0b0b0c" }, dataSources: [],
    layers: [
      { id: uid("big"), type: "text", x: 6, y: 20, width: 88, height: 30, content: "$100", fontFamily: "Archivo Black", fontWeight: "bold", fontSize: 300, color: "#d4af37", align: "center", autoFit: true, maxLines: 1, visible: true },
      { id: uid("h"), type: "text", x: 8, y: 52, width: 84, height: 10, content: "on us, {{contact.first_name}}", fontFamily: "Inter", fontWeight: "bold", fontSize: 56, color: "#ffffff", align: "center", autoFit: true, maxLines: 1, visible: true },
      { id: uid("sub"), type: "text", x: 12, y: 64, width: 76, height: 10, content: "Credit toward your next project with {{loc.business_name}}. This month only.", fontFamily: "Inter", fontWeight: "regular", fontSize: 36, color: "#9ca3af", align: "center", lineHeight: 1.2, autoFit: true, maxLines: 3, visible: true },
      { id: uid("badge"), type: "badge", x: 30, y: 80, width: 40, height: 8, icon: "dollar", text: "Reply to claim", bgColor: "#d4af37", textColor: "#0b0b0c", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Matt", "loc.business_name": "Goldstar Plumbing" },
  };
}

/* ------------------------------------------------------------------ *
 * Property-imagery bases — one per imagery data source, so users can
 * see exactly what each provider produces and build on top of it.
 * The real image is fetched PER CONTACT at render time.
 * ------------------------------------------------------------------ */

// mapbox-parcel: satellite aerial with the contact's parcel outlined in gold.
export function parcelAerialBaseStarter({ locationId } = {}) {
  return {
    locationId, name: "Parcel Aerial Base", canvas: SQUARE, background: { color: "#0b0b0c" },
    dataSources: [
      { id: "parcel", provider: "mapbox-parcel",
        inputs: { address: "{{contact.custom.property_address}}" },
        options: { county: "king-wa", mapStyle: "satellite-v9", parcelColor: "#d4af37", showBuilding: false, padding: 40 },
        connectionId: "", discoveredKeys: ["apn", "lot_sqft", "address"], thumbnailUrl: IMG.thumbAerial },
    ],
    layers: [
      { id: uid("dimg"), type: "dynamic-image", sourceId: "parcel", x: 0, y: 0, width: 100, height: 100, fit: "cover", thumbnailUrl: IMG.thumbAerial, visible: true },
      { id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 66, width: 100, height: 34, fill: "rgba(0,0,0,0.55)", cornerRadius: 0, visible: true },
      { id: uid("addr"), type: "text", x: 6, y: 70, width: 88, height: 8, content: "{{contact.custom.property_address}}", fontFamily: "Inter", fontWeight: "bold", fontSize: 42, color: "#ffffff", align: "center", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("badge"), type: "badge", x: 27, y: 84, width: 46, height: 7, icon: "pin", text: "{{data.parcel.lot_sqft}} sq ft lot", bgColor: "#d4af37", textColor: "#0b0b0c", fontFamily: "Inter", fontSize: 32, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica", "contact.custom.property_address": "2847 41st Ave SW, Seattle, WA", "data.parcel.lot_sqft": "7200" },
  };
}

// mapbox-pin: satellite top view centred on the address with a marker.
export function satelliteViewBaseStarter({ locationId } = {}) {
  return {
    locationId, name: "Satellite View Base", canvas: SQUARE, background: { color: "#0b0b0c" },
    dataSources: [
      { id: "map", provider: "mapbox-pin",
        inputs: { address: "{{contact.custom.property_address}}" },
        options: { mapStyle: "satellite-streets-v12", zoom: 17, marker: true },
        connectionId: "", discoveredKeys: ["lat", "lng", "formatted_address"], thumbnailUrl: IMG.thumbSatellite },
    ],
    layers: [
      { id: uid("dimg"), type: "dynamic-image", sourceId: "map", x: 0, y: 0, width: 100, height: 100, fit: "cover", thumbnailUrl: IMG.thumbSatellite, visible: true },
      { id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 0, width: 100, height: 22, fill: "rgba(0,0,0,0.45)", cornerRadius: 0, visible: true },
      { id: uid("h"), type: "text", x: 6, y: 5, width: 88, height: 10, content: "{{contact.first_name}}, your neighborhood", fontFamily: "Inter", fontWeight: "bold", fontSize: 50, color: "#ffffff", align: "center", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("badge"), type: "badge", x: 22, y: 88, width: 56, height: 7, icon: "pin", text: "{{contact.custom.property_address}}", bgColor: "#ffffff", textColor: "#0b0b0c", fontFamily: "Inter", fontSize: 28, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica", "contact.custom.property_address": "2847 41st Ave SW, Seattle, WA" },
  };
}

// google-streetview: street-level photo of the address (satellite fallback).
export function streetViewBaseStarter({ locationId } = {}) {
  return {
    locationId, name: "Street View Base", canvas: SQUARE, background: { color: "#0b0b0c" },
    dataSources: [
      { id: "street", provider: "google-streetview",
        inputs: { address: "{{contact.custom.property_address}}" },
        options: { fov: 80, pitch: 0, fallbackToSatellite: true },
        connectionId: "", discoveredKeys: ["lat", "lng", "pano_date"], thumbnailUrl: IMG.thumbStreet },
    ],
    layers: [
      { id: uid("dimg"), type: "dynamic-image", sourceId: "street", x: 0, y: 0, width: 100, height: 100, fit: "cover", thumbnailUrl: IMG.thumbStreet, visible: true },
      { id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 62, width: 100, height: 38, fill: "rgba(0,0,0,0.55)", cornerRadius: 0, visible: true },
      { id: uid("h"), type: "text", x: 6, y: 66, width: 88, height: 10, content: "Looking good, {{contact.first_name}}!", fontFamily: "Inter", fontWeight: "bold", fontSize: 52, color: "#ffffff", align: "center", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("addr"), type: "text", x: 8, y: 79, width: 84, height: 7, content: "{{contact.custom.property_address}}", fontFamily: "Inter", fontWeight: "regular", fontSize: 34, color: "#d1d5db", align: "center", autoFit: true, maxLines: 1, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica", "contact.custom.property_address": "2847 41st Ave SW, Seattle, WA" },
  };
}

// website-shot: a screenshot of the contact's own website — the "we looked at
// your site" opener for agencies/service businesses.
export function websiteShotBaseStarter({ locationId } = {}) {
  return {
    locationId, name: "Website Screenshot Base", canvas: SQUARE, background: { color: "#0b0b0c" },
    dataSources: [
      { id: "site", provider: "website-shot",
        inputs: { url: "{{contact.website}}" },
        options: { width: 1200 },
        connectionId: "", discoveredKeys: ["url"], thumbnailUrl: IMG.thumbStreet },
    ],
    layers: [
      { id: uid("dimg"), type: "dynamic-image", sourceId: "site", x: 0, y: 0, width: 100, height: 72, fit: "cover", thumbnailUrl: IMG.thumbStreet, visible: true },
      { id: uid("scrim"), type: "shape", shape: "rect", x: 0, y: 62, width: 100, height: 38, fill: "rgba(0,0,0,0.75)", cornerRadius: 0, visible: true },
      { id: uid("h"), type: "text", x: 6, y: 74, width: 88, height: 10, content: "{{contact.first_name}}, we took a look at your site", fontFamily: "Inter", fontWeight: "bold", fontSize: 50, color: "#ffffff", align: "center", lineHeight: 1.1, autoFit: true, maxLines: 2, visible: true },
      { id: uid("badge"), type: "badge", x: 22, y: 88, width: 56, height: 7, icon: "check", text: "{{contact.website}}", bgColor: "#d4af37", textColor: "#0b0b0c", fontFamily: "Inter", fontSize: 28, cornerRadius: 999, visible: true },
    ],
    sampleData: { "contact.first_name": "Jessica", "contact.website": "example.com" },
  };
}

// Registry of starters the editor can offer. `category` groups them in the
// picker; `message` is the matching SMS copy applied when the preset is chosen.
// `purpose` maps a starter to a Home section (quotes|reviews|winback|offers)
// or "general"; `industry` powers the gallery filter (home-services, roofing,
// real-estate, lending, general).
export function starterList() {
  return [
    /* ---- quotes ---- */
    { id: "quote-follow-up", name: "Quote Follow-Up", category: "Home page", purpose: "quotes", industry: "home-services", build: quoteFollowUpStarter,
      message: "Hi {{first_name}}, your quote for {{contact.custom.property_address}} is good through {{contact.custom.quote_expiry}}. Want me to hold your spot on next week's schedule?" },
    { id: "quote-expiring", name: "Quote Expiring", category: "Home page", purpose: "quotes", industry: "general", build: quoteExpiringStarter,
      message: "{{first_name}}, your quote of ${{contact.custom.quote_amount}} is locked until {{contact.custom.quote_expiry}} — reply YES and I'll hold your spot." },
    { id: "roof-quote", name: "Roof Quote", category: "Home page", purpose: "quotes", industry: "roofing", build: roofQuoteStarter,
      message: "Hi {{first_name}}, your roof quote for {{contact.custom.property_address}} is ${{contact.custom.quote_amount}}, good through {{contact.custom.quote_expiry}}. Questions? Just reply." },
    /* ---- reviews ---- */
    { id: "review-request", name: "Review Request", category: "Reviews", purpose: "reviews", industry: "general", build: reviewRequestStarter,
      message: "Hey {{first_name}}, we hope you enjoyed your experience with {{business_name}}! Would you mind taking a moment to leave a review? Here's the link: [Review Link]" },
    { id: "five-star-ask", name: "Five-Star Ask", category: "Reviews", purpose: "reviews", industry: "general", build: fiveStarAskStarter,
      message: "{{first_name}}, how did we do? A quick review helps {{business_name}} a ton: [Review Link]" },
    { id: "job-done-review", name: "Job Done — Review", category: "Reviews", purpose: "reviews", industry: "home-services", build: jobDoneReviewStarter,
      message: "{{first_name}}, thanks for trusting {{business_name}} with your {{contact.custom.job_type}}! If the crew earned it, a quick review helps us a ton: [Review Link]" },
    { id: "thank-you", name: "Thank You", category: "Reviews", purpose: "reviews", industry: "general", build: thankYouStarter,
      message: "Thanks so much, {{first_name}}! It was a pleasure working with you. If you have a second, we'd love a quick review: [Review Link]" },
    /* ---- winback ---- */
    { id: "property-card", name: "Property Card", category: "Real estate", purpose: "winback", industry: "home-services", build: propertyCardStarter,
      message: "Hi {{first_name}}, here's a look at the property at {{contact.custom.property_address}}. Reply if you'd like the full details!" },
    { id: "time-for-another", name: "Time For Another", category: "Services", purpose: "winback", industry: "home-services", build: timeForAnotherStarter,
      message: "Hi {{first_name}}, it's been a while since your {{contact.custom.last_service_type}} — want me to pencil you in this month at your returning-customer rate?" },
    { id: "season-due", name: "Season Due", category: "Services", purpose: "winback", industry: "roofing", build: seasonDueStarter,
      message: "Hi {{first_name}}, moss season is back and your roof was last treated {{contact.custom.last_service_date}}. Want me to get you on this month's schedule?" },
    /* ---- offers ---- */
    { id: "offer-terms", name: "Offer Terms", category: "Home page", purpose: "offers", industry: "lending", build: offerTermsStarter,
      message: "{{first_name}} — your pricing just changed. Reply if you've got anything in the works." },
    { id: "loyalty-offer", name: "Loyalty Offer", category: "Services", purpose: "offers", industry: "home-services", build: loyaltyOfferStarter,
      message: "{{first_name}} — {{contact.custom.deal_count}} jobs with us earns you member pricing on the next one. Want a quote?" },
    { id: "comeback-credit", name: "Comeback Credit", category: "General", purpose: "offers", industry: "general", build: comebackCreditStarter,
      message: "{{first_name}}, we've put a $100 credit on your account toward your next project with {{business_name}} — this month only. Reply to claim it." },
    /* ---- property imagery bases (one per data source) ---- */
    { id: "parcel-aerial-base", name: "Parcel Aerial", category: "Real estate", purpose: "imagery", industry: "general", build: parcelAerialBaseStarter,
      message: "Hi {{first_name}}, here's a look at your property at {{contact.custom.property_address}} — reply if you'd like to talk!" },
    { id: "satellite-view-base", name: "Satellite View", category: "Real estate", purpose: "imagery", industry: "general", build: satelliteViewBaseStarter,
      message: "Hi {{first_name}}, spotted your place at {{contact.custom.property_address}} — reply if you'd like to talk!" },
    { id: "street-view-base", name: "Street View", category: "Real estate", purpose: "imagery", industry: "general", build: streetViewBaseStarter,
      message: "Hi {{first_name}}, your place at {{contact.custom.property_address}} is looking great — reply if you'd like to talk!" },
    { id: "website-shot-base", name: "Website Screenshot", category: "General", purpose: "imagery", industry: "general", build: websiteShotBaseStarter,
      message: "Hi {{first_name}}, we took a look at {{contact.website}} — got a couple of ideas that could bring you more customers. Want me to send them over?" },
    /* ---- general ---- */
    { id: "just-listed", name: "Just Listed", category: "Real estate", purpose: "general", industry: "real-estate", build: justListedStarter,
      message: "Hi {{first_name}}! 🏡 A new listing just hit the market at {{contact.custom.property_address}}. Want the details or a private tour? Just reply here." },
    { id: "home-value", name: "Home Value", category: "Real estate", purpose: "general", industry: "real-estate", build: homeValueStarter,
      message: "Hi {{first_name}}, curious what your home at {{contact.custom.property_address}} could sell for in today's market? Reply and I'll send a free, no-obligation valuation." },
    { id: "service-special", name: "Service Special", category: "Services", purpose: "general", industry: "home-services", build: serviceSpecialStarter,
      message: "Hey {{first_name}}! For a limited time, get 20% off with {{business_name}}. Book by Friday to lock it in — just reply to claim it." },
    { id: "appointment-reminder", name: "Appointment Reminder", category: "Services", purpose: "general", industry: "home-services", build: appointmentReminderStarter,
      message: "Hi {{first_name}}, you're all set with {{business_name}}! Reply here anytime if you have questions before your appointment." },
    { id: "welcome", name: "Welcome", category: "General", purpose: "general", industry: "general", build: welcomeStarter,
      message: "Welcome, {{first_name}}! 🎉 Thanks for choosing {{business_name}} — we're thrilled to have you. Reply anytime if you need anything." },
  ];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v * 10) / 10));
}
function safeHex(v, fb) {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v || "")) ? v : fb;
}
