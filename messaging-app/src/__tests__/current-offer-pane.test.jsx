import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OfferPanelBody, parseAmount } from "../OfferPanel.jsx";

// 13041 SE 208th St, Kent (2026-09-25): five rows on one house. The pane says
// which is current, what the older ones are, and offers the re-quote when the
// paper was held.
const A = "13041 SE 208th St, Kent, WA 98031";
const aug = { id: "aug", contactId: "c1", address: A, cashAmount: 421556, status: "passed", createdAt: "2026-08-05T16:31:00Z", sends: [{ ts: "2026-08-05T16:31:42Z" }],
  paperHeld: { at: "2026-09-25T02:07:34Z", reason: "we texted 400K on 2026-08-07 after this offer's $421,556", amount: 400000 } };
const july = { id: "july", contactId: "c1", address: A, cashAmount: 416500, status: "countered", createdAt: "2026-07-27T22:35:00Z", sends: [{ ts: "2026-07-27T22:44:00Z" }] };

test("the pane marks the current offer, calls the older one superseded, and offers the re-quote", () => {
  const html = renderToStaticMarkup(<OfferPanelBody offer={aug} siblings={[aug, july]} item={{ offerId: "aug" }} onRequote={() => {}} />);
  expect(html).toContain("current");
  expect(html).toContain("+1 older on this house");
  expect(html).toContain("Paper held.");
  expect(html).toContain("Re-quote at 400K");
});

test("a row that pointed at the older offer says it is showing the current one", () => {
  const html = renderToStaticMarkup(<OfferPanelBody offer={aug} siblings={[aug, july]} item={{ offerId: "july" }} replaced={july} />);
  expect(html).toContain("pointed at an older offer");
  expect(html).toContain("$416,500");
});

test("our number can be re-quoted in place, except on a deal", () => {
  const live = renderToStaticMarkup(<OfferPanelBody offer={july} siblings={[july]} item={{ offerId: "july" }} onRequote={() => ({})} />);
  const pencil = (html) => html.match(/<button[^>]*aria-label="Change our offer"[^>]*>/)?.[0] || "";
  expect(pencil(live)).not.toBe("");
  expect(pencil(live)).not.toContain(`disabled=""`);
  const deal = renderToStaticMarkup(<OfferPanelBody offer={{ ...july, deal: { stage: "under_contract" } }} siblings={[]} item={{ offerId: "july" }} onRequote={() => ({})} />);
  expect(pencil(deal)).toContain(`disabled=""`);
  expect(deal).toContain("It&#x27;s a deal — change the price on the deal");
});

test("an agreed price can still be re-quoted, and the pencil says it takes the agreement back — Woodcrest", () => {
  const agreed = { ...july, status: "countered", agreed: { amount: 402500, at: "2026-10-02T18:05:31Z", via: "counter_band" } };
  const html = renderToStaticMarkup(<OfferPanelBody offer={agreed} siblings={[agreed]} item={{ offerId: "july" }} onRequote={() => ({})} />);
  const pencil = html.match(/<button[^>]*aria-label="Change our offer"[^>]*>/)?.[0] || "";
  expect(pencil).not.toContain(`disabled=""`);
  expect(pencil).toContain("Agreed at $402,500 — re-quoting takes that back (sends nothing)");
});

test("a typed re-quote reads 750k, $750,000 and a bare 750 as the same number", () => {
  expect(parseAmount("750k")).toBe(750000);
  expect(parseAmount("$750,000")).toBe(750000);
  expect(parseAmount("750")).toBe(750000);
  expect(parseAmount("1.2m")).toBe(1200000);
  expect(parseAmount("abc")).toBe(0);
});

test("switching between their offers happens in the pane, with the one shown marked", () => {
  const html = renderToStaticMarkup(<OfferPanelBody offer={aug} siblings={[aug, july]} item={{ offerId: "aug", contactName: "Rae Q" }} onSelectOffer={() => {}} />);
  expect(html).toContain("Offers with Rae · 1");
  expect(html).toContain("+1 older on this house");
  expect(html).toMatch(/aria-current="true"[^>]*>[\s\S]*?13041 SE 208th St/);
});

// Kimberly, 12201 Champion Dr SW (2026-10-26): two drafts a minute apart, one
// without the SW, listed as two offers on one house.
test("two drafts of one house are one line, with the older one folded under it", () => {
  const sw = { id: "sw", contactId: "k", address: "12201 Champion Dr SW, Olympia, WA 98512", status: "draft", draft: {}, createdAt: "2026-10-26T16:02:00Z" };
  const bare = { id: "bare", contactId: "k", address: "12201 Champion Dr", status: "draft", draft: {}, createdAt: "2026-10-26T16:03:00Z" };
  const other = { id: "oak", contactId: "k", address: "9 Oak St, Kent, WA", cashAmount: 300000, status: "sent", createdAt: "2026-10-01T00:00:00Z" };
  const html = renderToStaticMarkup(<OfferPanelBody offer={other} siblings={[sw, bare, other]} item={{ offerId: "oak", contactName: "Kimberly T" }} onSelectOffer={() => {}} />);
  expect(html).toContain("Offers with Kimberly · 2");
  expect(html).toContain("+1 older on this house");
  expect(html).not.toContain("12201 Champion Dr SW<");
  // Showing the older one opens its house.
  const open = renderToStaticMarkup(<OfferPanelBody offer={sw} siblings={[sw, bare, other]} item={{ offerId: "sw", contactName: "Kimberly T" }} onSelectOffer={() => {}} />);
  expect(open).not.toContain("older on this house");
  expect(open).toMatch(/aria-current="true"[^>]*>[\s\S]*?12201 Champion Dr SW/);
});

// 2026-10-20, no Today: "approve the agreed number" was a Today row and
// nowhere else. It is on the offer now, wherever the offer shows.
test("an agreed number Matt hasn't approved is approved from the offer itself", () => {
  // The machine's number (a hand-made one is approved by being made).
  const agreed = { ...july, cashAmount: 416500, autoUnderwrite: { finishedAt: "2026-10-19T18:00:00Z" }, agreed: { amount: 416500, at: "2026-10-20T18:05:31Z", via: "realm_yes" } };
  const html = renderToStaticMarkup(<OfferPanelBody offer={agreed} siblings={[agreed]} item={{ offerId: "july" }} />);
  expect(html).toContain("Approve 416.5K");
  expect(html).toContain("no write-up ask until you approve");
  const done = renderToStaticMarkup(<OfferPanelBody offer={{ ...agreed, approved: { amount: 416500, at: "2026-10-20T19:00:00Z", by: "you" } }} siblings={[]} item={{ offerId: "july" }} />);
  expect(done).not.toContain("Approve 416.5K");
  const over = renderToStaticMarkup(<OfferPanelBody offer={{ ...agreed, agreed: { amount: 430000, at: "2026-10-20T18:05:31Z", via: "counter" } }} siblings={[]} item={{ offerId: "july" }} />);
  expect(over).not.toContain("Approve");
});
