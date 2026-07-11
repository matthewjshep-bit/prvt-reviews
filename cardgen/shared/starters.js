// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

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

// Registry of starters the editor can offer. `category` groups them in the
// picker; `message` is the matching SMS copy applied when the preset is chosen.
export function starterList() {
  return [
    { id: "review-request", name: "Review Request", category: "Reviews", build: reviewRequestStarter,
      message: "Hey {{first_name}}, we hope you enjoyed your experience with {{business_name}}! Would you mind taking a moment to leave a review? Here's the link: [Review Link]" },
    { id: "thank-you", name: "Thank You", category: "Reviews", build: thankYouStarter,
      message: "Thanks so much, {{first_name}}! It was a pleasure working with you. If you have a second, we'd love a quick review: [Review Link]" },
    { id: "property-card", name: "Property Card", category: "Real estate", build: propertyCardStarter,
      message: "Hi {{first_name}}, here's a look at the property at {{contact.custom.property_address}}. Reply if you'd like the full details!" },
    { id: "just-listed", name: "Just Listed", category: "Real estate", build: justListedStarter,
      message: "Hi {{first_name}}! 🏡 A new listing just hit the market at {{contact.custom.property_address}}. Want the details or a private tour? Just reply here." },
    { id: "home-value", name: "Home Value", category: "Real estate", build: homeValueStarter,
      message: "Hi {{first_name}}, curious what your home at {{contact.custom.property_address}} could sell for in today's market? Reply and I'll send a free, no-obligation valuation." },
    { id: "service-special", name: "Service Special", category: "Services", build: serviceSpecialStarter,
      message: "Hey {{first_name}}! For a limited time, get 20% off with {{business_name}}. Book by Friday to lock it in — just reply to claim it." },
    { id: "appointment-reminder", name: "Appointment Reminder", category: "Services", build: appointmentReminderStarter,
      message: "Hi {{first_name}}, you're all set with {{business_name}}! Reply here anytime if you have questions before your appointment." },
    { id: "welcome", name: "Welcome", category: "General", build: welcomeStarter,
      message: "Welcome, {{first_name}}! 🎉 Thanks for choosing {{business_name}} — we're thrilled to have you. Reply anytime if you need anything." },
  ];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v * 10) / 10));
}
function safeHex(v, fb) {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v || "")) ? v : fb;
}
