// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// rehab-catalog.js — the scope-of-work line-item catalog, shared by the
// RehabPane UI (checkboxes/tiers) and the broker's AI photo-scan endpoint
// (Claude maps what it sees in listing photos onto these exact item ids).
// Pure data, no deps.

// mode: "flat" ($ once) | "qty" ($ × count) | "sqft" ($ × subject sqft)
export const REHAB_CATALOG = [
  { group: "Kitchen", items: [
    { id: "kit-reface", label: "Cabinet paint / reface", mode: "flat", unit: 3000 },
    { id: "kit-cab", label: "New cabinets & countertops", mode: "flat", unit: 12000 },
    { id: "kit-counter", label: "Countertops only", mode: "flat", unit: 3500 },
    { id: "kit-appl", label: "Appliance package", mode: "flat", unit: 4500 },
    { id: "kit-sink", label: "Sink & faucet", mode: "flat", unit: 600 },
    { id: "kit-bs", label: "Backsplash", mode: "flat", unit: 800 },
    { id: "kit-floor", label: "Kitchen flooring", mode: "flat", unit: 1500 },
    { id: "kit-gut", label: "Full kitchen gut remodel", mode: "flat", unit: 25000 },
  ]},
  { group: "Living areas & interior", items: [
    { id: "paint-int", label: "Interior paint (whole house)", mode: "sqft", unit: 3 },
    { id: "lvp", label: "LVP flooring throughout", mode: "sqft", unit: 6 },
    { id: "living", label: "Living / dining refresh", mode: "flat", unit: 1500 },
    { id: "fireplace", label: "Fireplace refacing", mode: "flat", unit: 1200 },
    { id: "popcorn", label: "Popcorn ceiling removal", mode: "sqft", unit: 2 },
    { id: "drywall", label: "Drywall / wall repairs", mode: "flat", unit: 2000 },
    { id: "doors", label: "Interior doors & trim", mode: "flat", unit: 2500 },
    { id: "fixtures", label: "Light fixtures & hardware", mode: "flat", unit: 1200 },
    { id: "blinds", label: "Blinds / window coverings", mode: "flat", unit: 800 },
  ]},
  { group: "Systems", items: [
    { id: "roof", label: "Roof replacement", mode: "flat", unit: 12000 },
    { id: "hvac", label: "HVAC / furnace", mode: "flat", unit: 8000 },
    { id: "wh", label: "Water heater", mode: "flat", unit: 1800 },
    { id: "elec", label: "Electrical panel / updates", mode: "flat", unit: 4000 },
    { id: "plumb", label: "Plumbing updates", mode: "flat", unit: 5000 },
    { id: "sewer", label: "Sewer line repair", mode: "flat", unit: 8000 },
    { id: "insul", label: "Insulation / attic", mode: "flat", unit: 1500 },
    { id: "windows", label: "Windows", mode: "qty", unit: 650 },
  ]},
  { group: "Exterior", items: [
    { id: "paint-ext", label: "Exterior paint", mode: "flat", unit: 6000 },
    { id: "siding", label: "Siding repair", mode: "flat", unit: 4000 },
    { id: "gutters", label: "Gutters", mode: "flat", unit: 900 },
    { id: "landscape", label: "Yard cleanup & landscaping", mode: "flat", unit: 2500 },
    { id: "deck", label: "Deck / fence repair", mode: "flat", unit: 3500 },
    { id: "concrete", label: "Driveway / concrete", mode: "flat", unit: 2500 },
    { id: "garage", label: "Garage door", mode: "flat", unit: 1200 },
  ]},
  { group: "Other", items: [
    { id: "junk", label: "Junk-out / cleanout", mode: "flat", unit: 1500 },
    { id: "pest", label: "Pest / dry-rot repair", mode: "flat", unit: 3000 },
    { id: "found", label: "Foundation repair", mode: "flat", unit: 10000 },
    { id: "permits", label: "Permits & misc", mode: "flat", unit: 1500 },
  ]},
];

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
