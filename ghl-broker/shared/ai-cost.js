// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// ai-cost.js — what one Claude call cost, from its own usage block.
//
// The broker records `usage` on every reply draft (and the shadow's beside
// it), so spend is read off the app's own rows rather than guessed from the
// Console's daily bars. Prices are per million tokens, from the pricing page
// (2026-09-25); a model missing here costs null rather than a wrong number.
//
// Multipliers on base input: 5-minute cache write 1.25x, 1-hour write 2x,
// cache read 0.1x. The Batch API halves every one of them.
//
// Pure.

export const PRICES = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * usageOf(response, { model, batched }) → a flat, storable usage row
 *
 *   { model, input, cacheRead, cacheWrite5m, cacheWrite1h, output, batched, costUsd }
 */
export function usageOf(response, { model = "", batched = false } = {}) {
  const u = response?.usage || {};
  const write = Number(u.cache_creation_input_tokens) || 0;
  const w1h = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
  const w5m = u.cache_creation ? Number(u.cache_creation.ephemeral_5m_input_tokens) || 0 : write - w1h;
  const row = {
    model: String(response?.model || model || ""),
    input: Number(u.input_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheWrite5m: Math.max(0, w5m),
    cacheWrite1h: w1h,
    output: Number(u.output_tokens) || 0,
    batched: Boolean(batched),
  };
  return { ...row, costUsd: costOf(row) };
}

// The listed model a (possibly dated or aliased) id bills as.
const priceFor = (model = "") => {
  const m = String(model);
  const key = Object.keys(PRICES).find((k) => m === k || m.startsWith(`${k}-`));
  return key ? PRICES[key] : null;
};

/** costOf(row) → dollars (6 dp), or null when the model isn't priced here. */
export function costOf(row = {}) {
  const p = priceFor(row.model);
  if (!p) return null;
  const perTok = (rate) => rate / 1e6;
  const inRate = perTok(p.input);
  const dollars =
    (Number(row.input) || 0) * inRate +
    (Number(row.cacheRead) || 0) * inRate * 0.1 +
    (Number(row.cacheWrite5m) || 0) * inRate * 1.25 +
    (Number(row.cacheWrite1h) || 0) * inRate * 2 +
    (Number(row.output) || 0) * perTok(p.output);
  return Math.round(dollars * (row.batched ? 0.5 : 1) * 1e6) / 1e6;
}
