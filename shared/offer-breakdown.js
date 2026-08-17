// offer-breakdown.js — "how we got to this number", written for the listing
// agent rather than for us.
//
// The offer letter states a price. An agent who can see the arithmetic behind
// it argues with the inputs instead of dismissing the offer as a lowball, which
// is the whole reason this section exists.
//
// The constraint that shapes everything here: the agent must NOT see the
// assignment fee. It's our margin, and an agent who can read it off a web page
// will take it to their seller as "they're marking your house up $15k".
//
// The naive fix — print the stack and delete the fee row — is worse than
// printing the fee. The backstack model is
//
//     offer = ARV − selling costs − flip profit − repairs − holding − fee
//
// so a column with the fee row removed sums to offer + fee, and the fee is
// recoverable by anyone who subtracts. A visibly-wrong column also destroys the
// credibility the section was supposed to buy.
//
// So one line is computed as the RESIDUAL: whatever it takes for the column to
// total the offer actually printed on the letter. That line is labelled to
// cover what it genuinely contains — the buyer's return plus their acquisition
// costs, which is what our fee is from the seller's side of the table. It ties
// out exactly regardless of rounding, the lowball model's cents jitter, or a
// manual price override, because it's derived from the final number rather than
// from the model that suggested it.
//
// Pure functions. Money in whole dollars.

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const pct = (v) => {
  const n = num(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

// Rows: { key, label, amount, sign }  sign: "+" | "−"
// Returns null when there's nothing defensible to show.
export function offerBreakdown(offer) {
  const cash = offer?.calc?.offers?.cash;
  if (!cash) return null;

  // A negative stack means repairs and profit exceed the ARV. The offer clamps
  // to 0, and a breakdown of a $0 offer reads as a bug rather than a position.
  if (cash.underwater) return null;

  const amount = Math.round(num(cash.amount));
  // The ARV comes from the inputs, never from cash.base. In backstack mode
  // those happen to be equal, but the percentage models set base to the
  // DISCOUNTED basis (70% of ARV) — using it there would both mislabel the top
  // line and shrink the residual to exactly the assignment fee, printing the
  // one number this module exists to withhold.
  const arv = Math.round(num(offer?.calc?.inputs?.arv) || (cash.mode === "backstack" ? num(cash.base) : 0));
  if (amount <= 0 || arv <= 0) return null;

  const repairs = Math.round(num(cash.repairs));
  const rows = [{ key: "arv", label: "After-repair value", amount: arv, sign: "+" }];

  // Only the backstack model has costs an agent would recognise as real and
  // checkable. The percentage models compress into a single margin line —
  // dressing them up with invented cost categories would be a lie that a
  // sharp agent could catch.
  const isBackstack = cash.mode === "backstack";
  if (isBackstack) {
    const sellingCosts = Math.round(num(cash.sellingCosts));
    const holding = Math.round(num(cash.holding));
    if (sellingCosts > 0) {
      rows.push({
        key: "selling",
        label: `Resale costs (${pct(cash.sellingCostPct)}%)`,
        amount: sellingCosts, sign: "−",
      });
    }
    if (holding > 0) {
      rows.push({
        key: "holding",
        label: `Carrying costs (${pct(cash.holdMonths)} months)`,
        amount: holding, sign: "−",
      });
    }
  }

  if (repairs > 0) {
    rows.push({ key: "repairs", label: "Renovation budget", amount: repairs, sign: "−" });
  }

  // The residual. Everything above is stated; this is whatever remains between
  // the ARV and the offer we actually printed — which is exactly the buyer's
  // return plus their cost of acquiring the deal, undivided.
  const stated = rows.reduce((t, r) => t + (r.sign === "+" ? r.amount : -r.amount), 0);
  const margin = stated - amount;
  if (margin > 0) {
    rows.push({
      key: "return",
      label: isBackstack ? "Buyer's return & acquisition costs" : "Buyer's margin & acquisition costs",
      amount: margin, sign: "−",
    });
  } else if (margin < 0) {
    // The printed offer exceeds what the stated costs leave room for — only
    // reachable via a manual price override set above the model. Say so
    // plainly rather than emitting a negative subtraction.
    rows.push({ key: "premium", label: "Premium over our model", amount: -margin, sign: "+" });
  }

  return {
    rows,
    total: amount,
    // Rendered as a caption. Kept out of the rows so it can't be mistaken for
    // a line item in the arithmetic.
    basis: isBackstack
      ? "Every cost the buyer carries between purchase and resale, subtracted from what the property is worth once renovated."
      : "The buyer's basis after renovation and their required return.",
  };
}

// Guard used by the tests and by anything that wants to assert the promise
// this module exists to keep: the column adds up, and the fee never appears.
export function breakdownTotals(breakdown) {
  if (!breakdown) return null;
  const sum = breakdown.rows.reduce((t, r) => t + (r.sign === "+" ? r.amount : -r.amount), 0);
  return { sum, total: breakdown.total, balanced: sum === breakdown.total };
}
