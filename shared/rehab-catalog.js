// rehab-catalog.js — the scope-of-work line-item catalog, shared by the
// RehabPane UI (checkboxes/tiers) and the broker's AI photo-scan endpoint
// (Claude maps what it sees in listing photos onto these exact item ids).
// Pure data, no deps.

// The house size the flat unit costs below are priced for. They were written
// against a "typical" 3/2, and without the scaling in lineCost() a 770 sqft
// cottage got billed $6,000 to paint its exterior and $12,000 to reroof a
// footprint a third that size.
export const REHAB_BASELINE_SQFT = 1500;

// How a flat cost moves with house size. Half the money in a scaling line is
// effectively fixed — mobilization, a minimum crew day, the trip charge, the
// permit — and half tracks the area actually being worked. So a house at half
// the baseline costs ~75% of the baseline price, not 50%. Clamped at both ends
// because neither a shed nor a mansion is really linear.
export function sizeFactor(sqft) {
  const s = Number(sqft) || 0;
  if (s <= 0) return 1; // size unknown: don't guess, use the catalog price
  return Math.min(1.5, Math.max(0.6, 0.5 + 0.5 * (s / REHAB_BASELINE_SQFT)));
}

// One place that turns a catalog item + its row into dollars, so the pane, the
// scope PDF and anything else can never disagree about a number.
//   mode "sqft" — already per-square-foot, no factor
//   mode "qty"  — per unit, the count is the scaling
//   mode "flat" — scaled only when the item's cost really tracks house size
export function lineCost(item, row = {}, sqft = 0) {
  const unit = Number(row.unit ?? item.unit) || 0;
  if (item.mode === "sqft") return unit * (Number(sqft) || 0);
  if (item.mode === "qty") return unit * (Number(row.qty) || 1);
  return item.scales ? unit * sizeFactor(sqft) : unit;
}

// mode: "flat" ($ once) | "qty" ($ × count) | "sqft" ($ × subject sqft)
// scales: flat items whose cost genuinely tracks house size. A kitchen in a
// small house has fewer linear feet of cabinet; a water heater is one water
// heater at any size, and a deck belongs to the lot rather than the house.
export const REHAB_CATALOG = [
  { group: "Kitchen", items: [
    { id: "kit-reface", label: "Cabinet paint / reface", mode: "flat", unit: 3000, scales: true },
    { id: "kit-cab", label: "New cabinets & countertops", mode: "flat", unit: 12000, scales: true },
    { id: "kit-counter", label: "Countertops only", mode: "flat", unit: 3500, scales: true },
    { id: "kit-appl", label: "Appliance package", mode: "flat", unit: 4500 },
    { id: "kit-sink", label: "Sink & faucet", mode: "flat", unit: 600 },
    { id: "kit-bs", label: "Backsplash", mode: "flat", unit: 800, scales: true },
    { id: "kit-floor", label: "Kitchen flooring", mode: "flat", unit: 1500, scales: true },
    { id: "kit-gut", label: "Full kitchen gut remodel", mode: "flat", unit: 25000, scales: true },
  ]},
  { group: "Living areas & interior", items: [
    { id: "paint-int", label: "Interior paint (whole house)", mode: "sqft", unit: 3 },
    { id: "lvp", label: "LVP flooring throughout", mode: "sqft", unit: 6 },
    { id: "living", label: "Living / dining refresh", mode: "flat", unit: 1500, scales: true },
    { id: "fireplace", label: "Fireplace refacing", mode: "flat", unit: 1200 },
    { id: "popcorn", label: "Popcorn ceiling removal", mode: "sqft", unit: 2 },
    { id: "drywall", label: "Drywall / wall repairs", mode: "flat", unit: 2000, scales: true },
    { id: "doors", label: "Interior doors & trim", mode: "flat", unit: 2500, scales: true },
    { id: "fixtures", label: "Light fixtures & hardware", mode: "flat", unit: 1200, scales: true },
    { id: "blinds", label: "Blinds / window coverings", mode: "flat", unit: 800, scales: true },
  ]},
  { group: "Systems", items: [
    { id: "roof", label: "Roof replacement", mode: "flat", unit: 12000, scales: true },
    { id: "hvac", label: "HVAC / furnace", mode: "flat", unit: 8000, scales: true },
    { id: "wh", label: "Water heater", mode: "flat", unit: 1800 },
    { id: "elec", label: "Electrical panel / updates", mode: "flat", unit: 4000 },
    { id: "plumb", label: "Plumbing updates", mode: "flat", unit: 5000, scales: true },
    { id: "sewer", label: "Sewer line repair", mode: "flat", unit: 8000 },
    { id: "insul", label: "Insulation / attic", mode: "flat", unit: 1500, scales: true },
    { id: "windows", label: "Windows", mode: "qty", unit: 650 },
  ]},
  { group: "Exterior", items: [
    { id: "paint-ext", label: "Exterior paint", mode: "flat", unit: 6000, scales: true },
    { id: "siding", label: "Siding repair", mode: "flat", unit: 4000, scales: true },
    { id: "gutters", label: "Gutters", mode: "flat", unit: 900, scales: true },
    { id: "landscape", label: "Yard cleanup & landscaping", mode: "flat", unit: 2500 },
    { id: "deck", label: "Deck / fence repair", mode: "flat", unit: 3500 },
    { id: "concrete", label: "Driveway / concrete", mode: "flat", unit: 2500 },
    { id: "garage", label: "Garage door", mode: "flat", unit: 1200 },
  ]},
  { group: "Other", items: [
    { id: "junk", label: "Junk-out / cleanout", mode: "flat", unit: 1500, scales: true },
    { id: "pest", label: "Pest / dry-rot repair", mode: "flat", unit: 3000, scales: true },
    { id: "found", label: "Foundation repair", mode: "flat", unit: 10000, scales: true },
    { id: "permits", label: "Permits & misc", mode: "flat", unit: 1500 },
  ]},
];

// Matt's rehab cost cheat sheet — whole-project ranges by house size, used as
// the quick Light/Medium/Heavy buckets and as the sanity band shown next to an
// itemized total. `heavy` is open-ended in the original ("+"), so heavyOpen
// marks that exceeding it is a judgement call rather than an error.
export const REHAB_BANDS = [
  { max: 1000, label: "under 1,000 sqft", light: [20000, 30000], medium: [30000, 50000], heavy: [50000, 70000] },
  { max: 1500, label: "1,000–1,500 sqft", light: [40000, 50000], medium: [50000, 70000], heavy: [70000, 90000] },
  { max: 2000, label: "1,500–2,000 sqft", light: [60000, 70000], medium: [70000, 90000], heavy: [90000, 110000] },
  { max: 2500, label: "2,000–2,500 sqft", light: [70000, 80000], medium: [80000, 100000], heavy: [100000, 120000] },
  { max: Infinity, label: "over 2,500 sqft", light: [80000, 90000], medium: [90000, 110000], heavy: [110000, 130000] },
];

export const REHAB_LEVELS = [
  { id: "light", label: "Light" },
  { id: "medium", label: "Medium" },
  { id: "heavy", label: "Heavy" },
];

// The band for a given size. Null when the size is unknown — a guess here would
// anchor the whole repair number on nothing.
export function rehabBand(sqft) {
  const s = Number(sqft) || 0;
  if (s <= 0) return null;
  return REHAB_BANDS.find((b) => s <= b.max) || REHAB_BANDS[REHAB_BANDS.length - 1];
}

// Midpoint of a band level — what a bucket button seeds, rounded to $500 the
// same way the itemized total is.
export function bandMidpoint(sqft, level) {
  const band = rehabBand(sqft);
  const range = band && band[level];
  if (!range) return 0;
  return Math.round((range[0] + range[1]) / 2 / 500) * 500;
}

export const BED_TIERS = [
  { id: "none", label: "No work", unit: 0 },
  { id: "refresh", label: "Refresh (paint + carpet)", unit: 900 },
  { id: "full", label: "Full redo (floor/paint/closet/door)", unit: 2200 },
];

export const BATH_TIERS = [
  { id: "none", label: "No work", unit: 0 },
  { id: "refresh", label: "Refresh (vanity/toilet/fixtures)", unit: 1800 },
  { id: "mid", label: "Mid remodel (surround/tile/vanity)", unit: 8000 },
  { id: "gut", label: "Full gut", unit: 12000 },
];

export const ALL_REHAB_ITEMS = REHAB_CATALOG.flatMap((g) => g.items);
