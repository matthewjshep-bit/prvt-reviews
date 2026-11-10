// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// ai-cost.js — what one Claude call cost, from its own usage block.
//
// The broker records `usage` on every reply draft (and the shadow's beside
// it), so spend is read off the app's own rows rather than guessed from the
// Console's daily bars. Prices are per million tokens, from the pricing page
// (2026-09-25; the 5.5 models added 2026-11-09); a model missing here costs
// null rather than a wrong number, and ai-spend.js says so once a day.
//
// Multipliers on base input: 5-minute cache write 1.25x, 1-hour write 2x,
// cache read 0.1x unless the row lists its own `cacheRead` rate (Opus 5.5
// reads at $0.20, a twentieth of its input). A row with `longOver` bills the
// whole call at `long` once the prompt (input and cache, read or written)
// passes that many tokens. The Batch API halves every one of them.
//
// Pure.

export const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longOver: 100000, long: { input: 0.5, output: 2.5 } },
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

// The listed model a (possibly dated or aliased) id bills as: the longest
// name it starts with, so "claude-opus-5-5" is never billed as "claude-opus-5".
export const priceFor = (model = "") => {
  const m = String(model);
  const key = Object.keys(PRICES).filter((k) => m === k || m.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
  return key ? PRICES[key] : null;
};

/** costOf(row) → dollars (6 dp), or null when the model isn't priced here. */
export function costOf(row = {}) {
  const listed = priceFor(row.model);
  if (!listed) return null;
  const input = Number(row.input) || 0;
  const cacheRead = Number(row.cacheRead) || 0;
  const w5m = Number(row.cacheWrite5m) || 0;
  const w1h = Number(row.cacheWrite1h) || 0;
  const long = listed.longOver && input + cacheRead + w5m + w1h > listed.longOver;
  const p = long ? { ...listed, ...listed.long } : listed;
  const perTok = (rate) => rate / 1e6;
  const inRate = perTok(p.input);
  const readRate = !long && p.cacheRead != null ? perTok(p.cacheRead) : inRate * 0.1;
  const dollars =
    input * inRate +
    cacheRead * readRate +
    w5m * inRate * 1.25 +
    w1h * inRate * 2 +
    (Number(row.output) || 0) * perTok(p.output);
  return Math.round(dollars * (row.batched ? 0.5 : 1) * 1e6) / 1e6;
}
