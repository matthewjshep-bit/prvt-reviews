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

// Registry of starters the editor can offer.
export function starterList() {
  return [
    { id: "review-request", name: "Review Request", build: reviewRequestStarter },
    { id: "property-card", name: "Property Card", build: propertyCardStarter },
    { id: "thank-you", name: "Thank You", build: thankYouStarter },
  ];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v * 10) / 10));
}
function safeHex(v, fb) {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v || "")) ? v : fb;
}
