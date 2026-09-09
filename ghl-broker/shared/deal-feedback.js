// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// deal-feedback.js — what the market said about a property, packaged for the
// listing agent.
//
// After a deal is blasted, the most valuable thing we hold is the buyers'
// reaction: who replied, who asked for the contract, who walked away and
// what they said when they did. Today that lives in twelve text threads and
// a handful of call recordings. This reads all of it and produces one honest
// package an agent can take to her seller — the numbers buyers were shown,
// the numbers they pushed back on, and their words, verbatim.
//
// Two audiences, one object. `buildFeedbackPackage` returns everything with
// full names and our internal fields; `renderFeedbackHtml` is the agent-facing
// view and is careful: buyers are first name + initial, our assignment fee is
// never printed, and nothing is paraphrased that can be quoted.
//
// Pure. Threads and events come in as plain data; the route does the reading.

import { PASS_REASON_LABEL, normalizePassReason } from "./conversation-ai.js";
import { investorStatus } from "./offer-status.js";
import { addressKey } from "./contact-record.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const round = (v) => Math.round(Number(v) || 0);
export const money = (n) => `$${round(n).toLocaleString("en-US")}`;
const kText = (n) => (round(n) >= 1000 ? `$${Math.round(round(n) / 1000)}K` : money(n));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const streetLine = (a) => String(a || "").split(",")[0].trim();
const initials = (name) => {
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "A buyer";
  return p.length === 1 ? p[0] : `${p[0]} ${p[p.length - 1][0]}.`;
};

/* ---------- reading a thread ---------- */

// The transcript format enrich.js builds: "[YYYY-MM-DD HH:MM] US|THEM channel: body",
// with call transcripts as a header line followed by "Speaker N: …" lines.
// [^\r\n]* rather than .*$ — a message body from GHL can end in \r, and `.`
// does not match it, which silently dropped whole pitch lines.
const LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (US|THEM) (sms|email|call|voicemail)(?: TRANSCRIPT)?:?[ \t]?([^\r\n]*)/;
const GREETING_RE = /leave (your|a) message|forwarded to voicemail|not available|no transcript found|record your message|you('ve)? reached/i;

/**
 * parseThread(text) → [{ at, dir, channel, body, transcript: [{speaker, text}] | null }]
 */
export function parseThread(text = "") {
  const out = [];
  let cur = null;
  for (const raw0 of String(text || "").split("\n")) {
    const raw = raw0.replace(/\r$/, "");
    const m = LINE_RE.exec(raw);
    if (m) {
      cur = { at: m[1].replace(" ", "T") + ":00.000Z", dir: m[2], channel: m[3], body: m[4] || "", transcript: /TRANSCRIPT/.test(raw) ? [] : null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const sp = /^Speaker (\w+): ?(.*)$/.exec(raw);
    if (sp && cur.transcript) { cur.transcript.push({ speaker: sp[1], text: sp[2] }); continue; }
    if (cur.transcript && cur.transcript.length) { cur.transcript[cur.transcript.length - 1].text += ` ${raw.trim()}`; continue; }
    if (raw.trim()) cur.body += `\n${raw}`;
  }
  return out;
}

// Words that tie a sentence to THIS deal: the street line (with "West"/"W"
// both ways), the house number, the city, and the price the buyer was shown.
// Generic words like "rehab" are deliberately NOT here — a buyer discussing
// another property's rehab in the same thread would otherwise land on this
// one, which is exactly what happened before this list was tightened.
function dealWordsFor(offer, pitch = {}) {
  const raw = streetLine(offer.address).toLowerCase();
  const short = raw.replace(/\b(west|east|north|south)\b/g, (w) => w[0]);
  const long = raw.replace(/\b([wens])\b/g, (w) => ({ w: "west", e: "east", n: "north", s: "south" }[w]));
  const num = raw.split(" ")[0];
  const city = String(offer.address || "").split(",")[1]?.trim().toLowerCase() || "";
  const price = round(pitch.price);
  const priceWords = price ? [`${Math.round(price / 1000)}k`, `${Math.round(price / 1000)},`, money(price).toLowerCase()] : [];
  return [...new Set([raw, short, long, num, city, ...priceWords].filter((w) => w && w.length > 2))];
}
// How a buyer says no, or names a number, without naming the house.
const PASS_RE = /\bpass(ing|ed)?\b|not interested|no thanks|too (far|much|high|tight|small|big)|can'?t (do|make)|won'?t work|not (ready|for me|this one|right now)|aggressive|wiggle|closer to|tighter|doesn'?t (work|pencil)|way (over|more)/i;
const mentions = (text, words) => { const t = String(text || "").toLowerCase(); return words.some((w) => t.includes(w)); };
// The sentences of a message that are about THIS house: any that name it or
// carry a "no", plus the sentence that follows a naming one. Whole message
// when nothing matches — trimming to nothing would hide what they said.
export function trimToDeal(text = "", words = []) {
  const parts = String(text || "").split(/(?<=[.!?])\s+/);
  if (parts.length < 2) return String(text || "").trim();
  const keep = new Set();
  parts.forEach((x, i) => { if (mentions(x, words)) { keep.add(i); keep.add(i + 1); } else if (PASS_RE.test(x) || /\$\s?\d|\d{3}\s?k\b/i.test(x)) keep.add(i); });
  const out = parts.filter((_, i) => keep.has(i));
  return (out.length ? out : parts).join(" ").trim();
}
const isReaction = (body) => /^(loved|liked|laughed at|emphasized|questioned|disliked) [“"]/i.test(String(body || "").trim());

/**
 * excerptTranscript(transcript, words) → [{speaker, text}] — the sentences
 * that mention the deal, with one line of context either side, deduped and
 * capped. A voicemail greeting on its own is not a transcript.
 */
export function excerptTranscript(transcript = [], words = [], { max = 8 } = {}) {
  const lines = transcript.filter((l) => l.text && !GREETING_RE.test(l.text));
  if (!lines.length) return [];
  const keep = new Set();
  lines.forEach((l, i) => { if (mentions(l.text, words)) { keep.add(i - 1); keep.add(i); keep.add(i + 1); } });
  const idx = [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b).slice(0, max);
  return idx.map((i) => ({ speaker: lines[i].speaker, text: lines[i].text.trim().slice(0, 420) }));
}

// What a pass was about, from the buyer's own words, when nobody coded it.
export function inferReason(said = "", coded = null) {
  // The sentence that carries the "no" decides; the rest of the call is
  // context. A buyer who passed on this house "because it's too far" and then
  // chatted about another property's rehab did not pass over rehab.
  const sentences = String(said || "").split(/(?<=[.!?])\s+|\n+/);
  const noSentence = sentences.find((x) => PASS_RE.test(x));
  const t = String(noSentence || said || "").toLowerCase();
  const pick = (code, note) => ({ code, note: coded?.note || note });
  if (/rehab|repair|needs way (over|more)|work than|gut/.test(t)) return pick("rehab_scope", "doubted the rehab number");
  if (/too far|far from|drive|that area|north|south|east ?side|not this one|neighborhood|not that market|market at/.test(t)) return pick("area", "not their area");
  if (/wiggle|tighter|discipline|price|numbers|arv|resale|spread|closer to|aggressive|cheaper/.test(t)) return pick("price", "wanted a lower price");
  if (/not ready|timing|busy|next (year|month)|later|another one right now|too many/.test(t)) return pick("timing", "not right now");
  if (/not (a )?flip|don'?t flip|never done a flip|wrong (number|person)/.test(t)) return pick("other", "not a flipper");
  return coded || { code: "other", note: "no reason given" };
}

/* ---------- the package ---------- */

/**
 * buildFeedbackPackage({ offer, buyers, room, now, options })
 *
 *   offer    the full offer doc (deal, numbers, address)
 *   buyers   [{ contactId, name, status, reason, addedAt, thread, stats, events }]
 *            — one per investor on the deal, thread as enrich.js builds it
 *   room     { shareViews, uniqueVisitors, downloads, viewsByDay, lastViewedAt } | null
 *   options  { pitch: { price, rehab, arv } } — what buyers were told, when it
 *            differs from the offer doc (the blast copy is the truth here)
 */
export function buildFeedbackPackage({ offer, buyers = [], room = null, now = Date.now(), options = {} } = {}) {
  if (!offer?.id) throw new Error("buildFeedbackPackage needs an offer");
  const deal = offer.deal || {};
  const since = ms(deal.createdAt) ?? ms(offer.statusAt) ?? 0;
  const pitch0 = {
    price: round(options.pitch?.price) || round(deal.contractPrice) + round(deal.assignmentFee) || round(offer.cashAmount),
    rehab: round(options.pitch?.rehab) || round(offer.repairs ?? offer.calc?.inputs?.repairs),
    arv: round(options.pitch?.arv) || round(offer.arv ?? offer.calc?.inputs?.arv),
  };
  const pitch = pitch0;
  const words = dealWordsFor(offer, pitch);

  const rows = buyers.map((b) => {
    const parsed = parseThread(b.thread || "");
    const inWindow = parsed.filter((l) => (ms(l.at) ?? 0) >= since - DAY_MS);
    const theirs = inWindow.filter((l) => l.dir === "THEM" && (l.channel === "sms" || l.channel === "email") && l.body.trim() && !isReaction(l.body));
    const ours = inWindow.filter((l) => l.dir === "US");
    // When we put it in front of them: the first thing we sent in the deal's
    // window that names the street or the city, else the first thing we sent.
    // Replies are everything they said inside the window — counting only
    // from a guessed pitch line silently dropped a "Yes" that came in a minute
    // before the follow-up we happened to match.
    const street = streetLine(offer.address).toLowerCase().replace(/\b(west|east|north|south)\b/g, (w) => w[0]);
    const city = String(offer.address || "").split(",")[1]?.trim().toLowerCase() || "";
    const sentAt = ours.find((l) => mentions(l.body.toLowerCase().replace(/\b(west|east|north|south)\b/g, (w) => w[0]), [street, city].filter(Boolean)))?.at || ours[0]?.at || b.addedAt || null;
    const replies = theirs;
    // About this deal: names it, or is a no / a number with nothing else named.
    const quotes = replies.map((l) => ({ at: l.at, text: l.body.trim().slice(0, 600), aboutDeal: mentions(l.body, words) || PASS_RE.test(l.body), namesDeal: mentions(l.body, words) }));
    const calls = inWindow.filter((l) => (l.channel === "call" || l.channel === "voicemail") && l.transcript?.length)
      .map((l) => ({ at: l.at, dir: l.dir, lines: excerptTranscript(l.transcript, words) }))
      .filter((c) => c.lines.length);
    const asked = replies.some((l) => /contract|send (me )?(more|details|info|the)|photos|pics|email|address|link/i.test(l.body));
    const walk = replies.some((l) => /walk|go (out|by|see)|tour|showing|see it|check it out|look at it/i.test(l.body));
    const status = investorStatus(b.status);
    // The coded reason when a person or the bot filed one; otherwise read it
    // off what they said. "Not interested" with nothing else stays "other" —
    // an honest count beats a guessed one.
    const said = [...quotes.filter((q) => q.aboutDeal).map((q) => q.text), ...calls.flatMap((c) => c.lines.map((l) => l.text))].join(" \n ");
    const coded = b.reason ? normalizePassReason(b.reason) : null;
    const reason = status === "passed" ? (coded && coded.code !== "other" ? coded : inferReason(said, coded)) : coded;
    return {
      contactId: b.contactId, name: b.name || "A buyer", shortName: initials(b.name), status,
      sentAt, replied: replies.length > 0, repliedAt: replies[0]?.at || null, askedForMore: asked, talkedWalkthrough: walk,
      passed: status === "passed", reason, quotes, calls,
      sourceFlip: b.sourceFlip || null,
    };
  });

  const passes = rows.filter((r) => r.passed);
  const byCode = new Map();
  for (const r of passes) {
    const code = r.reason?.code || "other";
    if (!byCode.has(code)) byCode.set(code, { code, label: PASS_REASON_LABEL[code] || code, count: 0, buyers: [] });
    const g = byCode.get(code);
    g.count++;
    // For a price pass, the message where they named their number beats the
    // one where they first asked for wiggle room.
    const passing = r.quotes.filter((q) => q.aboutDeal && PASS_RE.test(q.text));
    const said = (code === "price" && passing.find((q) => /\$\s?\d|\d{3}\s?k\b/i.test(q.text))) || passing[0];
    const call = r.calls.flatMap((c) => c.lines.filter((l) => PASS_RE.test(l.text)).map((l) => ({ text: l.text, at: c.at, fromCall: true })))[0];
    const named = r.quotes.find((q) => q.namesDeal);
    const pick = said || call || named || null;
    g.buyers.push({ contactId: r.contactId, name: r.name, shortName: r.shortName, note: r.reason?.note || "",
      quote: pick ? trimToDeal(pick.text, words) : "", at: pick?.at || r.repliedAt, fromCall: Boolean(pick?.fromCall) });
  }
  const objections = [...byCode.values()].sort((a, b) => b.count - a.count);
  // The two objections that are about the HOUSE rather than the buyer. These
  // are the ones an agent can take to a seller.
  const aboutTheNumbers = objections.filter((o) => ["price", "rehab_scope", "condition"].includes(o.code));
  const aboutTheBuyer = objections.filter((o) => !["price", "rehab_scope", "condition"].includes(o.code));

  const funnel = {
    contacted: rows.length,
    replied: rows.filter((r) => r.replied).length,
    askedForMore: rows.filter((r) => r.askedForMore).length,
    talkedWalkthrough: rows.filter((r) => r.talkedWalkthrough).length,
    stillEvaluating: rows.filter((r) => r.status === "evaluating").length,
    committed: rows.filter((r) => r.status === "committed").length,
    passed: passes.length,
    silent: rows.filter((r) => !r.replied).length,
  };

  // A number a buyer said they would do, wherever they said it. Only counts a
  // figure below what they were asked — a buyer repeating our price back is
  // not naming theirs.
  const askedFor = [];
  for (const r of rows) {
    // Strict: only a message that names the house can name a price for it.
    const text = [...r.quotes.filter((q) => q.namesDeal).map((q) => q.text), r.reason?.note || ""].join(" ");
    const named = [...text.matchAll(/\$?\s?(\d{3})\s?k\b|\$(\d{3}),(\d{3})\b/gi)]
      .map((m) => (m[1] ? Number(m[1]) * 1000 : Number(m[2] + m[3])))
      .filter((n) => n > 50000 && n < pitch.price);
    if (named.length) askedFor.push({ contactId: r.contactId, shortName: r.shortName, name: r.name, amount: Math.min(...named) });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    property: {
      address: offer.address, street: streetLine(offer.address),
      beds: offer.snapshot?.subjectInfo?.beds ?? null, sqft: offer.snapshot?.subjectSqft ?? null,
    },
    agent: { name: offer.contactName || "", contactId: offer.contactId || null },
    deal: { stage: deal.stage, since: deal.createdAt || null, inspectionDate: deal.inspectionDate || null, closingDate: deal.closingDate || null },
    pitch,
    funnel,
    room: room ? { views: room.shareViews ?? room.views ?? 0, uniqueVisitors: room.uniqueVisitors ?? null, downloads: room.downloads ?? 0, viewsByDay: room.viewsByDay || [], lastViewedAt: room.lastViewedAt || null, firstViewedAt: room.firstViewedAt || null } : null,
    objections, aboutTheNumbers, aboutTheBuyer, askedFor, words,
    buyers: rows.sort((a, b) => (Number(b.replied) - Number(a.replied)) || String(a.name).localeCompare(String(b.name))),
    // Never printed for the agent; here so the operator's own view can be honest.
    internal: { contractPrice: round(deal.contractPrice), assignmentFee: round(deal.assignmentFee), cashAmount: round(offer.cashAmount) },
  };
}

/* ---------- the agent-facing page ---------- */

// A bare yyyy-mm-dd is a calendar day and prints as itself; a timestamp is
// shown in Pacific time, which is where these conversations happen.
const fmtDate = (iso) => {
  const s = String(iso || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const t = ms(s); return t == null ? "" : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
};

/**
 * renderFeedbackHtml(pkg, { from, brand, fullNames, showPrice, wrap })
 *
 * Returns page content: <title> and <style> first, then the report. `wrap`
 * adds the doctype/html/body shell for the broker route; the artifact host
 * supplies its own.
 */
export function renderFeedbackHtml(pkg, { from = "", brand = "", fullNames = false, showPrice = true, wrap = false } = {}) {
  const nm = (b) => (fullNames ? b.name : b.shortName);
  const words = pkg.words || [];
  const p = pkg.property; const f = pkg.funnel; const r = pkg.room;
  const numbers = pkg.aboutTheNumbers; const other = pkg.aboutTheBuyer;
  const replied = pkg.buyers.filter((b) => b.replied);
  const silent = pkg.buyers.filter((b) => !b.replied);
  const maxDay = Math.max(1, ...(r?.viewsByDay || []).map((d) => d.count));

  const quoteBlock = (b, q) => `
    <figure class="quote">
      <blockquote>${esc(q.text).replace(/\n+/g, "<br>")}</blockquote>
      <figcaption><span class="who">${esc(nm(b))}${q.fromCall ? " · on the phone" : ""}</span><span class="when">${esc(fmtDate(q.at))}</span></figcaption>
    </figure>`;
  const callBlock = (b, c) => `
    <div class="call">
      <div class="call-head"><span class="mono">${esc(fmtDate(c.at))}</span> · phone call with ${esc(nm(b))}</div>
      ${c.lines.map((l) => `<p class="line"><span class="spk">${l.speaker === "1" || l.speaker === "3" ? esc(nm(b)) : "Us"}</span>${esc(l.text)}</p>`).join("")}
    </div>`;

  const body = `
<title>${esc(p.street)} — What buyers said</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
  :root {
    --paper: #FBFAF6; --ink: #1B1A16; --muted: #6A665C; --line: #E3DFD4; --soft: #F1EEE6;
    --accent: #0E6B67; --accent-ink: #0A4F4C; --warn: #A45A08; --pass: #9F1239; --good: #14532D;
    --quote: #F6F3EC;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --paper: #15161A; --ink: #ECE9E0; --muted: #A5A196; --line: #2B2D33; --soft: #1D1F25;
    --accent: #5CC7C0; --accent-ink: #8FDCD6; --warn: #E0A04A; --pass: #F27E9D; --good: #7BD59A; --quote: #1B1D22;
  } }
  :root[data-theme="dark"] {
    --paper: #15161A; --ink: #ECE9E0; --muted: #A5A196; --line: #2B2D33; --soft: #1D1F25;
    --accent: #5CC7C0; --accent-ink: #8FDCD6; --warn: #E0A04A; --pass: #F27E9D; --good: #7BD59A; --quote: #1B1D22;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: "Source Sans 3", "Segoe UI", system-ui, sans-serif; font-size: 17px; line-height: 1.55; }
  .page { max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
  h1, h2, h3 { font-family: "Fraunces", Georgia, serif; font-weight: 600; text-wrap: balance; margin: 0; letter-spacing: -0.01em; }
  h1 { font-size: 2.4rem; line-height: 1.1; }
  h2 { font-size: 1.45rem; margin: 3rem 0 0.9rem; padding-top: 1.2rem; border-top: 1px solid var(--line); }
  h3 { font-size: 1.1rem; margin: 1.6rem 0 0.5rem; }
  p { margin: 0 0 1rem; max-width: 66ch; }
  .eyebrow { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); font-weight: 600; margin-bottom: 0.6rem; }
  .lede { font-size: 1.15rem; color: var(--ink); margin-top: 1rem; }
  .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.85em; }
  .muted { color: var(--muted); }
  .meta { color: var(--muted); font-size: 0.95rem; margin-top: 0.4rem; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 1.5rem; margin: 1.6rem 0 0.5rem; padding: 1rem 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .tile .n { font-family: "Fraunces", Georgia, serif; font-size: 1.9rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .tile .l { font-size: 0.82rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .funnel { display: grid; grid-template-columns: 11rem 1fr 3rem; gap: 0.35rem 0.8rem; align-items: center; font-variant-numeric: tabular-nums; max-width: 34rem; }
  .funnel .bar { height: 0.7rem; background: var(--soft); border-radius: 2px; overflow: hidden; }
  .funnel .bar i { display: block; height: 100%; background: var(--accent); }
  .funnel .n { text-align: right; font-weight: 600; }
  .side { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin: 1rem 0; }
  @media (max-width: 40rem) { .side, .tiles { grid-template-columns: 1fr; } .funnel { grid-template-columns: 8rem 1fr 2.5rem; } }
  .told { padding: 1rem 1.2rem; background: var(--soft); border-radius: 6px; }
  .told .row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.3rem 0; border-bottom: 1px dashed var(--line); font-variant-numeric: tabular-nums; }
  .told .row:last-child { border-bottom: 0; }
  .obj { margin: 1.2rem 0 0; padding-left: 1rem; border-left: 3px solid var(--pass); }
  .obj.soft { border-left-color: var(--line); }
  .obj h3 { margin-top: 0; }
  .obj .count { color: var(--muted); font-weight: 400; font-family: "Source Sans 3", sans-serif; font-size: 0.95rem; margin-left: 0.5rem; }
  .quote { margin: 0.9rem 0; padding: 0.9rem 1.1rem; background: var(--quote); border-radius: 6px; }
  .quote blockquote { margin: 0; font-size: 1.05rem; }
  .quote figcaption { display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.85rem; color: var(--muted); }
  .quote .who { font-weight: 600; color: var(--ink); }
  .call { margin: 0.9rem 0; padding: 0.9rem 1.1rem; border: 1px solid var(--line); border-radius: 6px; }
  .call-head { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.5rem; }
  .call .line { margin: 0.25rem 0; max-width: none; font-size: 0.98rem; }
  .call .spk { display: inline-block; min-width: 4.5rem; font-weight: 600; color: var(--accent-ink); }
  table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
  .tablewrap { overflow-x: auto; margin: 1rem 0; }
  th { text-align: left; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; padding: 0.4rem 0.6rem 0.4rem 0; border-bottom: 1px solid var(--line); }
  td { padding: 0.55rem 0.6rem 0.55rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.nowrap, .st { white-space: nowrap; }
  .st { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; background: var(--soft); color: var(--muted); }
  .st.passed { color: var(--pass); } .st.evaluating { color: var(--accent-ink); } .st.committed { color: var(--good); }
  .views { display: flex; gap: 4px; align-items: flex-end; height: 3.2rem; margin: 0.6rem 0; }
  .views i { display: block; flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; }
  .views-l { display: flex; gap: 4px; font-size: 0.75rem; color: var(--muted); } .views-l span { flex: 1; text-align: center; }
  .foot { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: 0.9rem; color: var(--muted); }
  @media print { body { font-size: 12pt; } .page { padding: 0; max-width: none; } h2 { break-after: avoid; } .quote, .call { break-inside: avoid; } }
</style>
<div class="page">
  <div class="eyebrow">${esc(brand || "Buyer feedback")} · ${esc(fmtDate(pkg.generatedAt))}</div>
  <h1>${esc(p.street)}</h1>
  <div class="meta">${esc(p.address)}${pkg.agent.name ? ` · prepared for ${esc(pkg.agent.name)}` : ""}${from ? ` by ${esc(from)}` : ""}</div>
  <p class="lede">We put this house in front of ${f.contacted} active cash buyers${r ? ` and ${r.views.toLocaleString()} people opened the package` : ""}. This is what they said — in their own words, unedited — and what it tells us about where the numbers need to be.</p>

  <div class="tiles">
    <div class="tile"><div class="n">${f.contacted}</div><div class="l">buyers contacted</div></div>
    <div class="tile"><div class="n">${f.replied}</div><div class="l">replied</div></div>
    <div class="tile"><div class="n">${f.passed}</div><div class="l">passed</div></div>
  </div>

  <h2>What buyers were told</h2>
  <div class="side">
    <div class="told">
      ${showPrice ? `<div class="row"><span>Price to a buyer</span><strong>${money(pkg.pitch.price)}</strong></div>` : ""}
      <div class="row"><span>Rehab estimate</span><strong>${money(pkg.pitch.rehab)}</strong></div>
      <div class="row"><span>After-repair value</span><strong>${money(pkg.pitch.arv)}</strong></div>
    </div>
    <div>
      <p class="muted" style="font-size:0.95rem">Every buyer got the same pitch: the address, photos and a walk-through video, the scope of work, and a link to the package with comps. ${r?.downloads ? `${r.downloads} of them downloaded the comps.` : ""}</p>
    </div>
  </div>

  <h2>How it landed</h2>
  <div class="funnel">
    ${[["Contacted", f.contacted], ["Replied", f.replied], ["Asked for more", f.askedForMore], ["Talked about walking it", f.talkedWalkthrough], ["Still looking at it", f.stillEvaluating + f.committed], ["Passed", f.passed]].map(([l, n]) => `
      <span>${l}</span><div class="bar"><i style="width:${Math.round((n / Math.max(1, f.contacted)) * 100)}%"></i></div><span class="n">${n}</span>`).join("")}
  </div>
  ${r && r.viewsByDay?.length ? `
  <h3>Package opens</h3>
  <p class="muted" style="font-size:0.95rem">${r.views.toLocaleString()} opens${r.uniqueVisitors ? ` from about ${r.uniqueVisitors} different people` : ""}${r.lastViewedAt ? `, most recently ${esc(fmtDate(r.lastViewedAt))}` : ""}. Buyers share these links with partners and lenders, which is why opens run well past the number we contacted.</p>
  <div class="views">${r.viewsByDay.map((d) => `<i title="${esc(d.date)}: ${d.count}" style="height:${Math.max(4, Math.round((d.count / maxDay) * 100))}%"></i>`).join("")}</div>
  <div class="views-l">${r.viewsByDay.map((d) => `<span>${esc(fmtDate(d.date))}</span>`).join("")}</div>` : ""}

  ${numbers.length ? `
  <h2>What they pushed back on</h2>
  <p>These are the passes that were about the house and its numbers — the ones worth taking to the seller.</p>
  ${numbers.map((o) => `
    <div class="obj">
      <h3>${esc(o.label)}<span class="count">${o.count} buyer${o.count === 1 ? "" : "s"}</span></h3>
      ${o.buyers.map((b) => (b.quote ? quoteBlock(b, { text: b.quote, at: b.at, fromCall: b.fromCall }) : `<p class="muted">${esc(nm(b))} — ${esc(b.note)}</p>`)).join("")}
    </div>`).join("")}
  ${pkg.askedFor.length ? `<p style="margin-top:1rem">Where a buyer named a number they would do, it was: ${pkg.askedFor.map((a) => `<strong>${money(a.amount)}</strong> (${esc(a.shortName)})`).join(", ")}.</p>` : ""}` : ""}

  ${other.length ? `
  <h2>Passes that weren't about the house</h2>
  <p class="muted" style="font-size:0.95rem">Timing, area, or a buyer who turned out not to be buying. Listed so the count is honest, not because they say anything about the property.</p>
  ${other.map((o) => `
    <div class="obj soft">
      <h3>${esc(o.label)}<span class="count">${o.count}</span></h3>
      ${o.buyers.map((b) => (b.quote && (o.code !== "other" || /interested|pass/i.test(b.quote)) ? quoteBlock(b, { text: b.quote, at: b.at }) : `<p class="muted">${esc(nm(b))} — ${esc(b.note || "no reason given")}</p>`)).join("")}
    </div>`).join("")}` : ""}

  ${replied.some((b) => b.calls.length) ? `
  <h2>From the phone calls</h2>
  <p class="muted" style="font-size:0.95rem">Transcribed automatically, so the odd word is off. The parts that touch this property.</p>
  ${replied.flatMap((b) => b.calls.map((c) => callBlock(b, c))).join("")}` : ""}

  <h2>Every buyer</h2>
  <div class="tablewrap"><table>
    <thead><tr><th>Buyer</th><th>Sent</th><th>Where it stands</th><th>What they said</th></tr></thead>
    <tbody>
      ${pkg.buyers.map((b) => `<tr>
        <td><strong>${esc(nm(b))}</strong>${b.sourceFlip ? `<div class="muted" style="font-size:0.8rem">${esc(b.sourceFlip)}</div>` : ""}</td>
        <td class="mono nowrap">${esc(fmtDate(b.sentAt))}</td>
        <td><span class="st ${b.status}">${b.status === "passed" ? (b.reason ? esc(PASS_REASON_LABEL[b.reason.code] || "passed") : "passed") : b.status === "committed" ? "committed" : b.replied ? "looking at it" : "no reply yet"}</span></td>
        <td>${b.quotes.length ? esc(trimToDeal((b.quotes.find((q) => q.aboutDeal && PASS_RE.test(q.text)) || b.quotes.find((q) => q.namesDeal) || b.quotes.find((q) => q.aboutDeal) || b.quotes[0]).text, words).slice(0, 220)) : b.calls.length ? `<span class="muted">by phone — see the calls below</span>` : `<span class="muted">—</span>`}</td>
      </tr>`).join("")}
    </tbody>
  </table></div>
  ${silent.length ? `<p class="muted" style="font-size:0.9rem">${silent.length} buyer${silent.length === 1 ? " has" : "s have"} not replied yet; they stay on the list.</p>` : ""}

  <div class="foot">Buyer names are shortened for their privacy. Quotes are verbatim from texts and transcribed calls. Prepared ${esc(fmtDate(pkg.generatedAt))}${from ? ` by ${esc(from)}` : ""}.</div>
</div>`;
  return wrap ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${body.slice(0, body.indexOf("<div class=\"page\">"))}</head><body>${body.slice(body.indexOf("<div class=\"page\">"))}</body></html>` : body;
}
