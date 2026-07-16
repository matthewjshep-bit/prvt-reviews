// model.js — client-side template/layer helpers. The broker (zod) is the
// authority on defaults + validation; these mirror it closely so new layers
// look right immediately and round-trip cleanly through save.

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id" + Math.random().toString(36).slice(2));

export const FONT_FAMILIES = ["Inter", "Source Serif", "Archivo Black"];

export const CANVAS_PRESETS = [
  { id: "square", label: "Square 1080", width: 1080, height: 1080 },
  { id: "landscape", label: "Landscape 1200×628", width: 1200, height: 628 },
  { id: "story", label: "Story 1080×1920", width: 1080, height: 1920 },
];

export const LAYER_META = {
  image: { label: "Image", icon: "🖼" },
  "dynamic-image": { label: "Dynamic image", icon: "🛰" },
  text: { label: "Text", icon: "T" },
  "name-box": { label: "Name box", icon: "▭" },
  shape: { label: "Shape", icon: "◼" },
  badge: { label: "Badge", icon: "★" },
};

export function newLayer(type, extra = {}) {
  const base = { id: uid(), type, x: 20, y: 40, width: 60, height: 15, rotation: 0, opacity: 1, visible: true, locked: false };
  switch (type) {
    case "image":
      return { ...base, x: 0, y: 0, width: 100, height: 100, src: "", fit: "cover", cornerRadius: 0, ...extra };
    case "dynamic-image":
      return { ...base, x: 0, y: 0, width: 100, height: 100, sourceId: "", fit: "cover", cornerRadius: 0, ...extra };
    case "text":
      return {
        ...base, height: 12, content: "Your text here", fontFamily: "Inter", fontWeight: "regular",
        fontSize: 48, color: "#ffffff", align: "left", lineHeight: 1.2, autoFit: false, maxLines: 3, ...extra,
      };
    case "name-box":
      return {
        ...base, x: 20, y: 60, width: 60, height: 12, content: "{{contact.first_name}}!",
        bgColor: "#ffffff", textColor: "#0b0b0c", fontFamily: "Inter", fontSize: 92, paddingX: 54, paddingY: 0, cornerRadius: 999, ...extra,
      };
    case "shape":
      return { ...base, x: 0, y: 55, width: 100, height: 45, shape: "rect", fill: "rgba(0,0,0,0.4)", cornerRadius: 0, ...extra };
    case "badge":
      return { ...base, x: 30, y: 82, width: 40, height: 8, icon: "star", text: "5.0 Google", bgColor: "#16a34a", textColor: "#ffffff", fontFamily: "Inter", fontSize: 40, cornerRadius: 999, ...extra };
    default:
      return base;
  }
}

// Build the merge-tag groups shown in the picker.
export function mergeTagGroups({ customFields = [], dataSources = [] }) {
  const standard = [
    "first_name", "last_name", "phone", "email", "website", "address1", "city", "state", "address_full",
  ].map((k) => ({ token: `contact.${k}`, label: k }));

  const custom = (customFields || []).map((f) => {
    // GHL fieldKey looks like "contact.property_address"; expose as contact.custom.<key>.
    const key = String(f.fieldKey || "").replace(/^contact\./, "");
    return { token: `contact.custom.${key}`, label: f.name || key };
  }).filter((t) => t.token !== "contact.custom.");

  const locFields = [
    { token: "loc.business_name", label: "Business name" },
    { token: "loc.owner_first_name", label: "Owner first name" },
  ];

  const data = [];
  for (const ds of dataSources || []) {
    for (const key of ds.discoveredKeys || []) data.push({ token: `data.${ds.id}.${key}`, label: `${ds.id}.${key}` });
  }

  return [
    { group: "Contact", tags: standard },
    { group: "Custom fields", tags: custom },
    { group: "Location", tags: locFields },
    ...(data.length ? [{ group: "Data sources", tags: data }] : []),
  ];
}

// Default sample values so the preview is populated out of the box.
export const DEFAULT_SAMPLE = {
  "contact.first_name": "Jessica",
  "contact.last_name": "Miller",
  "contact.phone": "+1 555 123 4567",
  "contact.city": "Seattle",
  "loc.business_name": "PRVT MKT",
};
