// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// income-underwrite.js — what an income property is worth to us, by its rent.
//
// A house is priced off comps: ARV, less the work, less our costs (offer-calc.js).
// A fourplex or a retail strip is priced off what it earns. Matt, 2026-10-18:
// when the offer is multi-family or commercial, underwrite it the way a
// commercial buyer would — NOI, cap rate, the loan the bank will size, and
// the returns we need — and the max offer is the HIGHEST price that passes
// every return test, with the test that set it named.
//
// Two layers:
//   - the income layer (rent roll → operating statement) is per property
//     kind: INCOME_LAYERS.multi_family (unit types) and .commercial (tenants
//     with leases and NNN recoveries). A new kind is a new layer.
//   - everything after NOI — loan sizing, returns, the max-offer tests, the
//     sensitivity grid, the checks — is shared and never branches on kind.
//
// Pure: no I/O, no UI. Percentages are decimals (0.05 = 5%). Deep copies go
// through JSON, never structuredClone (it isn't in every browser we serve).

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const copy = (x) => JSON.parse(JSON.stringify(x));

export const INCOME_KINDS = ["multi_family", "commercial"];

/* ---------- the deal ---------- */

// The assumptions every deal starts with. Matt can change any of them per
// offer; these are a reasonable small-multifamily lender and buyer in 2026.
const COMMON_DEFAULTS = {
  name: "",
  askingPrice: 0,
  rehab: 0,
  vacancy: 0.05,
  creditLoss: 0.01,
  rehabVacancy: 0.05,
  taxes: 0,
  insurance: 0,
  utilities: 0,
  admin: 0,
  mgmtPct: 0.08,
  ltv: 0.75,
  rate: 0.07,
  amortYears: 30,
  ioYears: 0,
  minDscr: 1.25,
  closingPct: 0.02,
  marketCap: 0.065,
  exitCap: 0.07,
  holdYears: 5,
  rentGrowth: 0.03,
  expGrowth: 0.03,
  saleCostPct: 0.03,
  targetCoc: 0.08,
  targetYoc: 0.075,
  targetIrr: 0.15,
};

export const DEFAULT_INCOME_DEAL = {
  multi_family: {
    kind: "multi_family", ...COMMON_DEFAULTS,
    units: [],
    otherIncome: 0,       // $ per unit per month (laundry, parking, pet rent)
    rmPerUnit: 600,       // repairs & maintenance, $ per unit per year
    reservesPerUnit: 300, // capital reserves, $ per unit per year
  },
  commercial: {
    kind: "commercial", ...COMMON_DEFAULTS,
    vacancy: 0.07,
    mgmtPct: 0.05,
    marketCap: 0.075,
    exitCap: 0.08,
    targetCoc: 0.09,
    targetYoc: 0.085,
    tenants: [],
    otherIncome: 0,       // $ per year (signage, parking, antenna)
    downtimeMonths: 6,    // a lease that ends sits empty this long before the next tenant pays
    rmPerUnit: 1.0,       // repairs & maintenance, $ per sq ft per year
    reservesPerUnit: 0.25, // reserves, $ per sq ft per year
  },
};

// Example figures only — labelled as such wherever they are shown.
export const SAMPLE_DEALS = {
  multi_family: {
    ...DEFAULT_INCOME_DEAL.multi_family,
    name: "Sample 8-plex (example figures)",
    askingPrice: 1295000,
    rehab: 120000,
    units: [
      { label: "2bd/1ba", count: 4, rent: 1350, marketRent: 1650 },
      { label: "1bd/1ba", count: 4, rent: 1100, marketRent: 1350 },
    ],
    otherIncome: 25,
    vacancy: 0.05,
    creditLoss: 0.01,
    rehabVacancy: 0.05,
    taxes: 14000,
    insurance: 7200,
    utilities: 9600,
    admin: 2000,
  },
  commercial: {
    ...DEFAULT_INCOME_DEAL.commercial,
    name: "Sample retail strip (example figures)",
    askingPrice: 1450000,
    rehab: 60000,
    tenants: [
      { name: "Coffee shop", sqft: 1400, rentPsf: 26, marketRentPsf: 28, recoveries: 9800, yearsLeft: 4 },
      { name: "Nail salon", sqft: 1200, rentPsf: 22, marketRentPsf: 26, recoveries: 8400, yearsLeft: 1 },
      { name: "Insurance office", sqft: 1000, rentPsf: 21, marketRentPsf: 24, recoveries: 7000, yearsLeft: 3 },
      { name: "Vacant suite", sqft: 1100, rentPsf: 0, marketRentPsf: 24, recoveries: 0, yearsLeft: 0 },
    ],
    otherIncome: 1800,
    taxes: 18500,
    insurance: 6200,
    utilities: 3600,
    admin: 2500,
  },
};

/** blankIncomeDeal(kind) → a fresh deal with the defaults and an empty rent roll. */
export function blankIncomeDeal(kind = "multi_family") {
  return copy(DEFAULT_INCOME_DEAL[INCOME_KINDS.includes(kind) ? kind : "multi_family"]);
}

/** sampleIncomeDeal(kind) → the example deal for that kind. */
export function sampleIncomeDeal(kind = "multi_family") {
  return copy(SAMPLE_DEALS[INCOME_KINDS.includes(kind) ? kind : "multi_family"]);
}

/**
 * normalizeIncomeDeal(raw) → a deal with every field a finite number and the
 * rent roll trimmed to real rows. Missing fields take the kind's defaults, so
 * an offer saved before a field existed still underwrites.
 */
export function normalizeIncomeDeal(raw = {}) {
  const kind = INCOME_KINDS.includes(raw?.kind) ? raw.kind : "multi_family";
  const base = DEFAULT_INCOME_DEAL[kind];
  const out = { kind, name: String(raw?.name ?? base.name).slice(0, 120) };
  for (const [k, v] of Object.entries(base)) {
    if (k === "kind" || k === "name" || Array.isArray(v)) continue;
    out[k] = raw?.[k] === undefined || raw?.[k] === null || raw?.[k] === "" ? v : num(raw[k]);
  }
  if (kind === "multi_family") {
    out.units = (Array.isArray(raw?.units) ? raw.units : []).slice(0, 40).map((u) => ({
      label: String(u?.label || "").slice(0, 60),
      count: Math.max(0, Math.round(num(u?.count))),
      rent: Math.max(0, num(u?.rent)),
      marketRent: Math.max(0, num(u?.marketRent)),
    }));
  } else {
    out.tenants = (Array.isArray(raw?.tenants) ? raw.tenants : []).slice(0, 60).map((t) => ({
      name: String(t?.name || "").slice(0, 60),
      sqft: Math.max(0, num(t?.sqft)),
      rentPsf: Math.max(0, num(t?.rentPsf)),
      marketRentPsf: Math.max(0, num(t?.marketRentPsf)),
      recoveries: Math.max(0, num(t?.recoveries)),
      yearsLeft: Math.max(0, num(t?.yearsLeft)),
    }));
  }
  return out;
}

/* ---------- the income layers (per property kind) ---------- */

// Each layer answers the same few questions for operate():
//   size(deal)             units, or rentable sq ft — what per-unit costs multiply
//   rents(deal, y, inPlace) → { base, recoveries, rollover }, all BEFORE growth
//   otherIncome(deal)      annual other income before growth
//   rentLift(deal)         market rent roll ÷ current rent roll − 1
//   sizeLabel              "unit" | "sq ft"
export const INCOME_LAYERS = {
  multi_family: {
    sizeLabel: "unit",
    size: (d) => (d.units || []).reduce((s, u) => s + num(u.count), 0),
    rents(d, y, inPlace) {
      const current = inPlace || y === 1;
      const base = (d.units || []).reduce((s, u) => s + num(u.count) * (current ? num(u.rent) : num(u.marketRent)) * 12, 0);
      return { base, recoveries: 0, rollover: 0 };
    },
    otherIncome: (d) => INCOME_LAYERS.multi_family.size(d) * num(d.otherIncome) * 12,
    rentLift(d) {
      const cur = (d.units || []).reduce((s, u) => s + num(u.count) * num(u.rent), 0);
      const mkt = (d.units || []).reduce((s, u) => s + num(u.count) * num(u.marketRent), 0);
      return cur > 0 ? mkt / cur - 1 : 0;
    },
  },
  // A tenant pays its current rent until its lease runs out (yearsLeft), then
  // market rent — after `downtimeMonths` empty while the space re-lets, in the
  // year the lease ends. A vacant suite is a lease with 0 years left and no
  // rent: it leases up in year 1. In place is today's leases and nothing else.
  commercial: {
    sizeLabel: "sq ft",
    size: (d) => (d.tenants || []).reduce((s, t) => s + num(t.sqft), 0),
    rents(d, y, inPlace) {
      let base = 0, recoveries = 0, rollover = 0;
      const down = Math.min(12, Math.max(0, num(d.downtimeMonths))) / 12;
      for (const t of d.tenants || []) {
        const left = num(t.yearsLeft);
        const rolled = !inPlace && y > left;
        const rent = num(t.sqft) * (rolled ? num(t.marketRentPsf) : num(t.rentPsf));
        const rec = num(t.recoveries);
        base += rent;
        recoveries += rec;
        // The year the space turns over: the new tenant's rent and recoveries
        // are missing for the downtime.
        if (rolled && y === Math.floor(left) + 1) rollover += (rent + rec) * down;
      }
      return { base, recoveries, rollover };
    },
    otherIncome: (d) => num(d.otherIncome),
    // Leased space only: leasing up a vacant suite isn't a rent raise.
    rentLift(d) {
      const leased = (d.tenants || []).filter((t) => num(t.rentPsf) > 0);
      const cur = leased.reduce((s, t) => s + num(t.sqft) * num(t.rentPsf), 0);
      const mkt = leased.reduce((s, t) => s + num(t.sqft) * num(t.marketRentPsf), 0);
      return cur > 0 ? mkt / cur - 1 : 0;
    },
  },
};

const layerOf = (d) => INCOME_LAYERS[d?.kind] || INCOME_LAYERS.multi_family;

/* ---------- 1. operating statement ---------- */

/**
 * operate(deal, y, inPlace) → the year-y operating statement.
 *
 * In place  = operate(deal, 1, true): today's rents, normal vacancy. The
 *             lender sizes the loan on this.
 * Stabilized = operate(deal, 2, false): market rents after the plan, one year
 *             of growth.
 */
export function operate(deal, y = 1, inPlace = false) {
  const d = deal;
  const L = layerOf(d);
  const size = L.size(d);
  const g = Math.pow(1 + num(d.rentGrowth), y - 1);
  const eg = Math.pow(1 + num(d.expGrowth), y - 1);
  const r = L.rents(d, y, inPlace);
  const gpr = r.base * g;
  const other = L.otherIncome(d) * g;
  const recoveries = r.recoveries * eg;
  const rollover = r.rollover * g;
  const vacancyRate = num(d.vacancy) + (y === 1 && !inPlace ? num(d.rehabVacancy) : 0);
  const vacancyLoss = gpr * vacancyRate;
  const creditLoss = gpr * num(d.creditLoss);
  const egi = gpr + other + recoveries - vacancyLoss - creditLoss - rollover;
  const expenses = {
    taxes: num(d.taxes) * eg,
    insurance: num(d.insurance) * eg,
    utilities: num(d.utilities) * eg,
    admin: num(d.admin) * eg,
    rm: num(d.rmPerUnit) * size * eg,
    reserves: num(d.reservesPerUnit) * size * eg,
    management: egi * num(d.mgmtPct),
  };
  const opex = Object.values(expenses).reduce((s, v) => s + v, 0);
  return {
    year: y, inPlace, size,
    gpr, other, recoveries, rollover, vacancyRate, vacancyLoss, creditLoss, egi,
    expenses, opex,
    noi: egi - opex,
    expenseRatio: egi > 0 ? opex / egi : NaN,
  };
}

/* ---------- 2. debt ---------- */

/** pmt(rate, years, loan) → the monthly payment. A 0% loan is loan ÷ months. */
export function pmt(rate, years, loan) {
  const n = num(years) * 12;
  if (!(n > 0)) return 0;
  const r = num(rate) / 12;
  if (r === 0) return num(loan) / n;
  return (num(loan) * r) / (1 - Math.pow(1 + r, -n));
}

/** loanConstant(deal) → annual debt service per $1 of loan, amortizing. */
export const loanConstant = (d) => pmt(d.rate, d.amortYears, 1) * 12;

/**
 * sizeLoan(deal, price, inPlaceNOI) → { loan, ltvLoan, dscrLoan, dscrCut }
 *
 * The bank lends the LESSER of LTV × price and the loan today's NOI covers at
 * the minimum DSCR. dscrCut says the income, not the price, set the loan.
 */
export function sizeLoan(d, price, inPlaceNOI) {
  const ltvLoan = Math.max(0, num(d.ltv) * num(price));
  const k = loanConstant(d);
  const dscrLoan = inPlaceNOI > 0 && k > 0 && num(d.minDscr) > 0 ? inPlaceNOI / (num(d.minDscr) * k) : 0;
  const loan = Math.max(0, Math.min(ltvLoan, dscrLoan));
  return { loan, ltvLoan, dscrLoan, dscrCut: dscrLoan < ltvLoan };
}

/** debtService(deal, loan, y) → interest-only for the IO years, then amortizing. */
export function debtService(d, loan, y) {
  if (y <= num(d.ioYears)) return loan * num(d.rate);
  return pmt(d.rate, d.amortYears, loan) * 12;
}

/** loanBalance(deal, loan, afterYears) → what's owed at sale. */
export function loanBalance(d, loan, afterYears) {
  const io = num(d.ioYears);
  if (afterYears <= io) return loan;
  const k = Math.round((afterYears - io) * 12);
  const r = num(d.rate) / 12;
  const p = pmt(d.rate, d.amortYears, loan);
  if (r === 0) return Math.max(0, loan - p * k);
  const f = Math.pow(1 + r, k);
  return Math.max(0, loan * f - (p * (f - 1)) / r);
}

/* ---------- IRR ---------- */

/** irr(flows) → the rate by bisection between −99% and 500%; NaN with no sign change. */
export function irr(flows = []) {
  const npv = (rate) => flows.reduce((s, cf, t) => s + cf / Math.pow(1 + rate, t), 0);
  let lo = -0.99, hi = 5;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/* ---------- 3. analyze at a price ---------- */

/**
 * analyze(deal, price, { exitCap }) → every return metric at that price.
 * `deal` must already be normalized (normalizeIncomeDeal).
 */
export function analyze(d, price, { exitCap } = {}) {
  const P = Math.max(0, num(price));
  const hold = Math.max(1, Math.round(num(d.holdYears)));
  const cap = exitCap ?? num(d.exitCap);
  const inPlace = operate(d, 1, true);
  const { loan, ltvLoan, dscrLoan, dscrCut } = sizeLoan(d, P, inPlace.noi);
  const closing = P * num(d.closingPct);
  const allIn = P + closing + num(d.rehab);
  const equity = allIn - loan;

  const years = [];
  for (let y = 1; y <= hold + 1; y++) {
    const op = operate(d, y, false);
    const ds = debtService(d, loan, y);
    years.push({ year: y, noi: op.noi, debtService: ds, cashFlow: op.noi - ds, op });
  }
  const exitNoi = years[hold].noi;
  const salePrice = cap > 0 ? exitNoi / cap : 0;
  const balance = loanBalance(d, loan, hold);
  const netSale = salePrice * (1 - num(d.saleCostPct)) - balance;
  const flows = [-equity, ...years.slice(0, hold).map((r) => r.cashFlow)];
  flows[hold] += netSale;

  const amortPayment = pmt(d.rate, d.amortYears, loan) * 12;
  const y2 = years[1];
  const ds2 = y2.debtService;
  const potential2 = y2.op.gpr + y2.op.other + y2.op.recoveries;
  const breakEven = potential2 > 0 ? (y2.op.opex - y2.op.expenses.management + ds2) / (potential2 * (1 - num(d.mgmtPct))) : NaN;
  const k = loanConstant(d);
  const inflows = flows.slice(1).reduce((s, v) => s + v, 0);
  const per = inPlace.size > 0 ? P / inPlace.size : 0;
  const ratio = (a, b) => (b > 0 ? a / b : NaN);

  return {
    price: P, closing, rehab: num(d.rehab), allIn, loan, ltvLoan, dscrLoan, dscrCut,
    effectiveLtv: ratio(loan, P),
    equity,
    years: years.slice(0, hold),
    exitNoi, exitCap: cap, salePrice, saleCosts: salePrice * num(d.saleCostPct), balance, netSale,
    flows,
    metrics: {
      inPlaceCap: ratio(inPlace.noi, P),
      yieldOnCost: ratio(y2.noi, allIn),
      dscr: amortPayment > 0 ? inPlace.noi / amortPayment : NaN,
      coc1: ratio(years[0].cashFlow, equity),
      coc2: ratio(y2.cashFlow, equity),
      irr: irr(flows),
      debtYield: ratio(inPlace.noi, loan),
      equityMultiple: ratio(inflows, equity),
      pricePer: per,
      grm: ratio(P, inPlace.gpr),
      expenseRatio: inPlace.expenseRatio,
      leverageSpread: ratio(inPlace.noi, P) - k,
      loanConstant: k,
      breakEven,
    },
  };
}

/* ---------- validation ---------- */

/** validateIncomeDeal(deal) → plain-English problems; [] means it can be priced. */
export function validateIncomeDeal(d) {
  const out = [];
  const L = layerOf(d);
  if (!(L.size(d) > 0)) out.push(d.kind === "commercial" ? "Add at least one tenant or suite with its square feet." : "Add at least one unit to the rent roll.");
  if (!(num(d.askingPrice) > 0)) out.push("Enter the asking price.");
  if (!(num(d.marketCap) > 0)) out.push("Market cap rate has to be above 0%.");
  if (!(num(d.exitCap) > 0)) out.push("Exit cap rate has to be above 0%.");
  const hold = num(d.holdYears);
  if (!(hold >= 1 && hold <= 15)) out.push("Hold period has to be 1 to 15 years.");
  if (!(num(d.amortYears) > 0)) out.push("Amortization has to be more than 0 years.");
  if (!(num(d.minDscr) > 0)) out.push("Minimum DSCR has to be above 0.");
  return out;
}

/* ---------- 4. max offer ---------- */

const ITERATIONS = 70;

// The largest price P in [1, hi] where test(P) holds. 0 when even $1 fails.
function solveMax(test, hi) {
  if (!test(1)) return 0;
  if (test(hi)) return hi;
  let lo = 1;
  for (let i = 0; i < ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (test(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

export const TEST_LABELS = {
  market: "Market value",
  coc: "Cash-on-cash",
  yoc: "Yield on cost",
  irr: "Levered IRR",
  dscr: "Lender DSCR",
};

/**
 * maxOffer(deal) → {
 *   maxOffer, binding, tests: [{ key, label, price, target, info, binding }],
 *   inPlace, stabilized, marketValue, stabilizedValue, at: analyze(maxOffer)
 * }
 *
 * The lowest of tests 1–4. The lender's DSCR price is informational: above it
 * the bank lends less and we bring more cash, and that smaller loan is
 * already inside the cash-on-cash and IRR tests — so it never caps the offer.
 */
export function maxOffer(deal) {
  const d = normalizeIncomeDeal(deal);
  const inPlace = operate(d, 1, true);
  const stabilized = operate(d, 2, false);
  const cap = num(d.marketCap);
  const marketValue = cap > 0 ? Math.max(0, inPlace.noi / cap) : 0;
  const stabilizedValue = cap > 0 ? Math.max(0, stabilized.noi / cap) : 0;
  const hi = 4 * Math.max(marketValue, stabilizedValue, num(d.askingPrice), 100000);

  const coc = solveMax((p) => {
    const m = analyze(d, p).metrics.coc2;
    return Number.isFinite(m) ? m >= num(d.targetCoc) : analyze(d, p).equity <= 0;
  }, hi);
  const yoc = num(d.targetYoc) > 0
    ? Math.max(0, (stabilized.noi / num(d.targetYoc) - num(d.rehab)) / (1 + num(d.closingPct)))
    : hi;
  const irrMax = solveMax((p) => {
    const m = analyze(d, p).metrics.irr;
    return Number.isFinite(m) && m >= num(d.targetIrr);
  }, hi);
  const { dscrLoan } = sizeLoan(d, 1, inPlace.noi);
  const dscrPrice = num(d.ltv) > 0 ? dscrLoan / num(d.ltv) : 0;

  const tests = [
    { key: "market", price: marketValue, target: cap },
    { key: "coc", price: coc, target: num(d.targetCoc) },
    { key: "yoc", price: yoc, target: num(d.targetYoc) },
    { key: "irr", price: irrMax, target: num(d.targetIrr) },
    { key: "dscr", price: dscrPrice, target: num(d.minDscr), info: true },
  ].map((t) => ({ ...t, label: TEST_LABELS[t.key], info: Boolean(t.info) }));

  const capping = tests.filter((t) => !t.info);
  const low = capping.reduce((a, b) => (b.price < a.price ? b : a));
  const best = Math.max(0, Math.floor(low.price));
  for (const t of tests) t.binding = t.key === low.key;
  return {
    maxOffer: best,
    binding: low.key,
    tests,
    inPlace, stabilized, marketValue, stabilizedValue,
    deal: d,
    at: best > 0 ? analyze(d, best) : null,
  };
}

/* ---------- 5. sensitivity ---------- */

export const SENS_PRICE_STEPS = [-0.10, -0.05, 0, 0.05, 0.10];
export const SENS_CAP_STEPS = [-0.005, -0.0025, 0, 0.0025, 0.005];

/** sensitivity(deal, basePrice) → { prices, caps, irr: [[...]] } rows = price, cols = exit cap. */
export function sensitivity(deal, basePrice) {
  const d = normalizeIncomeDeal(deal);
  const base = num(basePrice) > 0 ? num(basePrice) : num(d.askingPrice);
  const prices = SENS_PRICE_STEPS.map((s) => base * (1 + s));
  const caps = SENS_CAP_STEPS.map((s) => num(d.exitCap) + s);
  const grid = prices.map((p) => caps.map((c) => (c > 0 ? analyze(d, p, { exitCap: c }).metrics.irr : NaN)));
  return { prices, caps, irr: grid };
}

/* ---------- 6. red flags ---------- */

const pctText = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;
const moneyText = (v) => `$${Math.round(v).toLocaleString("en-US")}`;

/**
 * incomeFlags(deal, { asking, atMax }) → [{ key, level: good|warn|bad, text }]
 * `asking` and `atMax` are analyze() results (atMax may be null).
 */
export function incomeFlags(deal, { asking, atMax } = {}) {
  const d = normalizeIncomeDeal(deal);
  const inPlace = operate(d, 1, true);
  const out = [];
  const er = inPlace.expenseRatio;
  if (Number.isFinite(er)) {
    if (er < 0.35) out.push({ key: "expense_ratio", level: "bad", text: `Expense ratio is ${pctText(er)} — under 35% usually means the seller's numbers leave costs out. Rebuild them.` });
    else if (er > 0.55) out.push({ key: "expense_ratio", level: "warn", text: `Expense ratio is ${pctText(er)} — high. Check for one-off costs or a tax reassessment already in.` });
    else out.push({ key: "expense_ratio", level: "good", text: `Expense ratio is ${pctText(er)} — in the normal range.` });
  }
  if (asking) {
    const m = asking.metrics;
    if (Number.isFinite(m.inPlaceCap) && m.inPlaceCap < m.loanConstant) {
      out.push({ key: "negative_leverage", level: "bad", text: `Negative leverage at asking: the ${pctText(m.inPlaceCap, 2)} cap rate is below the ${pctText(m.loanConstant, 2)} loan constant, so every borrowed dollar lowers your return.` });
    } else if (Number.isFinite(m.inPlaceCap)) {
      out.push({ key: "negative_leverage", level: "good", text: `Positive leverage at asking: ${pctText(m.inPlaceCap, 2)} cap vs ${pctText(m.loanConstant, 2)} loan constant.` });
    }
    if (asking.dscrCut) {
      out.push({ key: "dscr_cut", level: "warn", text: `At asking the income only supports a ${moneyText(asking.loan)} loan (${pctText(asking.effectiveLtv)} LTV, not ${pctText(d.ltv, 0)}). You bring the difference in cash.` });
    }
  }
  if (atMax && Number.isFinite(atMax.metrics.yieldOnCost) && atMax.metrics.yieldOnCost < num(d.marketCap) + 0.0075) {
    out.push({ key: "thin_spread", level: "warn", text: `Yield on cost at the max offer is ${pctText(atMax.metrics.yieldOnCost, 2)} — less than 0.75 points over the ${pctText(d.marketCap, 2)} market cap. Thin room for the work.` });
  }
  if (num(d.exitCap) < num(d.marketCap)) {
    out.push({ key: "exit_cap", level: "warn", text: `Exit cap (${pctText(d.exitCap, 2)}) is below today's market cap (${pctText(d.marketCap, 2)}) — you're betting on the market getting better.` });
  }
  const be = (atMax || asking)?.metrics?.breakEven;
  if (Number.isFinite(be) && be > 0.88) {
    out.push({ key: "break_even", level: "bad", text: `Break-even occupancy is ${pctText(be)} — a few empty units and it stops paying the mortgage.` });
  }
  const lift = layerOf(d).rentLift(d);
  if (lift > 0.25) {
    out.push({ key: "rent_lift", level: "warn", text: `The plan raises rents ${pctText(lift, 0)} — back it up with rent comps.` });
  }
  return out;
}

/* ---------- one call for the UI and the server ---------- */

/**
 * underwriteIncome(deal) → { ok, errors, deal, result, asking, flags, sensitivity }
 *
 * The editor renders this; the server prices the offer from the same call.
 */
export function underwriteIncome(raw) {
  const deal = normalizeIncomeDeal(raw);
  const errors = validateIncomeDeal(deal);
  if (errors.length) return { ok: false, errors, deal };
  const result = maxOffer(deal);
  const asking = analyze(deal, deal.askingPrice);
  return {
    ok: true, errors: [], deal, result, asking,
    flags: incomeFlags(deal, { asking, atMax: result.at }),
    sensitivity: sensitivity(deal, result.maxOffer || deal.askingPrice),
    sizeLabel: layerOf(deal).sizeLabel,
  };
}

/** verdictOf(maxOffer, asking) → { gap, gapPct, status: works|close|over } */
export function verdictOf(max, asking) {
  const gap = num(max) - num(asking);
  const gapPct = num(asking) > 0 ? gap / num(asking) : 0;
  const status = gap >= 0 ? "works" : gapPct > -0.08 ? "close" : "over";
  return { gap, gapPct, status };
}
