// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// wa-psa-template.js — the Washington residential Purchase & Sale Agreement
// package as data: the Offer Summary cover, 22 numbered sections, Addendum A
// (as-is / no repairs / no buyer commission) and Addendum B (short sale
// lienholder approval), plus the closing disclaimer.
//
// This is the SELLER-FACING offer document. It exists because a Letter of
// Intent reads as a feeler — listing brokers push back on it — while this reads
// as an offer a seller can sign. Rendered by ghl-broker/psa-pdf.js.
//
// Two modes: "standard" (timelines run from Mutual Acceptance, Addendum A only)
// and "short_sale" (timelines run from written lienholder approval, Addendum A
// and B). Sections that differ carry a `bodyShortSale` override so the authored
// text of the other twenty stays verbatim instead of growing conditionals.
//
// Numbering here is EXPLICIT (`n`), not positional like contract-template.js —
// section bodies cross-reference each other by number ("§ 6", "§ 9"), so the
// numbers are part of the text and must never shift. A section that should not
// appear in a mode is filtered out, never renumbered; operator-authored extra
// terms render as an UNNUMBERED "Additional Terms" block for the same reason.
//
// Shared by the broker (PDF rendering) and the frontend (field labels). Pure
// data + string functions. Token merging reuses mergeTokens from
// contract-template.js — same {{token}} syntax, same blank-underscore fallback.

export const PSA_MODES = ["standard", "short_sale"];

// Every placeholder a section body may use, written as {{key}}. An empty value
// prints as an underscore run of blankWidth characters, so a partially filled
// agreement is still printable and signable by hand.
export const PSA_TOKENS = [
  { key: "effective_date", label: "Effective date", blankWidth: 18 },
  { key: "buyer_entity", label: "Buyer entity", blankWidth: 30 },
  { key: "buyer_state", label: "Buyer entity state", blankWidth: 12 },
  { key: "seller_name", label: "Seller name(s)", blankWidth: 30 },
  { key: "address", label: "Property address", blankWidth: 40 },
  { key: "apn", label: "Tax parcel / APN", blankWidth: 18 },
  { key: "legal_description", label: "Legal description", blankWidth: 60 },
  { key: "county", label: "County", blankWidth: 16 },
  { key: "price", label: "Purchase price", blankWidth: 14 },
  { key: "price_words", label: "Price in words", blankWidth: 40 },
  { key: "earnest_money", label: "Earnest money", blankWidth: 12 },
  { key: "feasibility_days", label: "Feasibility days", blankWidth: 4 },
  { key: "closing_days", label: "Days to closing", blankWidth: 4 },
  { key: "closing_date", label: "Closing date", blankWidth: 18 },
  { key: "backstop_date", label: "Backstop closing date", blankWidth: 18 },
  { key: "title_company", label: "Title / escrow company", blankWidth: 30 },
  { key: "title_officer", label: "Escrow officer", blankWidth: 24 },
  { key: "title_phone", label: "Escrow phone", blankWidth: 16 },
  { key: "lender_name", label: "Hard money lender", blankWidth: 26 },
  { key: "approval_deadline", label: "Lienholder approval deadline", blankWidth: 18 },
  { key: "counter_days", label: "Days to accept changed terms", blankWidth: 4 },
  { key: "offer_expires", label: "Offer expires", blankWidth: 24 },
  { key: "signer_name", label: "Signer", blankWidth: 24 },
  { key: "signer_email", label: "Signer email", blankWidth: 26 },
  { key: "signer_phone", label: "Signer phone", blankWidth: 16 },
];

/* ============================== Offer Summary ============================= */
// Page 1. Not part of the binding terms — it exists so a listing broker or a
// loss-mitigation reviewer can see the whole deal without reading nine pages,
// which is most of why this package gets taken seriously at all.

export const PSA_SUMMARY_TITLE = "OFFER SUMMARY";

export const PSA_SUMMARY_INTRO =
  "This summary is provided for the convenience of the Seller, the listing broker, and the " +
  "lienholder(s) reviewing this file. The complete and binding terms are set out in the Purchase " +
  "and Sale Agreement and Addenda that follow. In the event of a conflict, the Agreement and " +
  "Addenda control.";

export const PSA_BUYER_DISCLOSURE =
  "Buyer is a real estate investor purchasing as a principal for its own account. Buyer may " +
  "assign this Agreement to an affiliated or third-party purchaser prior to closing, and " +
  "discloses that intention here, in writing, before any party signs. Buyer is not a licensed " +
  "real estate broker and is not acting on behalf of any other person in this transaction.";

// Rows of the cover table. `emdExhibitNo` / `pofExhibitNo` are the exhibit
// numbers those documents were actually given (0 when the operator hasn't
// uploaded one) — an offer must never point at an exhibit that isn't in the
// envelope, so those clauses drop out rather than dangle.
export function psaSummaryRows(mode, { emdExhibitNo = 0, pofExhibitNo = 0 } = {}) {
  const short = mode === "short_sale";
  return [
    ["Property", "{{address}}  •  Parcel No. {{apn}}"],
    ["Buyer / Vesting", "{{buyer_entity}}, a {{buyer_state}} limited liability company, and/or assigns"],
    ["Purchase Price", "{{price}} U.S. dollars, all cash at closing"],
    ["Earnest Money",
      "{{earnest_money}}, deposited with the Closing Agent within three (3) business days of " +
      "Mutual Acceptance." + (emdExhibitNo ? ` Copy of check attached as Exhibit ${emdExhibitNo}.` : "")],
    ["Proof of Funds",
      pofExhibitNo
        ? `Cash purchase funded by {{lender_name}}. Lender proof-of-funds letter attached as Exhibit ${pofExhibitNo}. No financing contingency.`
        : "Cash purchase, funded from Buyer's own funds and committed lender capital. No financing contingency."],
    ["Closing Date",
      short
        ? "{{closing_days}} days after Buyer's receipt of written short sale approval from all lienholders, or {{backstop_date}}, whichever is later."
        : "On or before {{closing_date}}."],
    ["Contingencies",
      short
        ? "Feasibility / inspection: {{feasibility_days}} days, running from the date of written lienholder approval (§ 6). Short sale approval contingency per Addendum B. No financing or appraisal contingency."
        : "Feasibility / inspection: {{feasibility_days}} days from Mutual Acceptance (§ 6). No financing or appraisal contingency."],
    ["Property Condition",
      "Purchased strictly AS-IS, WHERE-IS. Seller to make no repairs and may leave any unwanted " +
      "personal property. See Addendum A."],
    ["Commissions",
      "No buyer brokerage commission is payable by Seller, Buyer, or any lienholder. Buyer is " +
      "unrepresented and acts as a principal."],
    ["Title / Escrow", "{{title_company}} — {{title_officer}} — {{title_phone}}"],
    ["Offer Expires", "{{offer_expires}} Pacific Time"],
    ["Buyer Disclosure", PSA_BUYER_DISCLOSURE, { italic: true }],
  ];
}

export const PSA_PACKAGE_TITLE = "Documents included in this offer package";

export function psaPackageList(mode, { emdExhibitNo = 0, pofExhibitNo = 0 } = {}) {
  const items = [
    "Offer Summary (this page)",
    "Purchase and Sale Agreement, signed by Buyer",
    "Addendum A — As-Is Purchase, No Repairs, No Buyer Commission",
  ];
  if (mode === "short_sale") {
    items.push("Addendum B — Short Sale / Third-Party Lienholder Approval Contingency");
  }
  const exhibits = [
    emdExhibitNo ? `Exhibit ${emdExhibitNo} — Copy of earnest money check payable to the Closing Agent` : "",
    pofExhibitNo ? `Exhibit ${pofExhibitNo} — Proof of funds letter` : "",
  ].filter(Boolean);
  items.push(...exhibits);
  return items;
}

/* ======================= Purchase and Sale Agreement ====================== */

export const PSA_TITLE = "PURCHASE AND SALE AGREEMENT";
export const PSA_SUBTITLE = "(Residential real property — State of Washington)";

// `n` is the printed number and is STABLE — bodies cite it. `modes` limits a
// section to one variant. `bodyShortSale` swaps the text without moving the
// number. `block` marks a body that renders indented and verbatim rather than
// as flowing prose (the legal description).
export const PSA_SECTIONS = [
  {
    n: 1, id: "parties", title: "Parties",
    body:
      'This Purchase and Sale Agreement (the "Agreement") is made between {{seller_name}} ("Seller") ' +
      'and {{buyer_entity}}, a {{buyer_state}} limited liability company, and/or assigns ("Buyer"). ' +
      "Title at closing will vest in {{buyer_entity}} or its assignee as designated by Buyer in " +
      "writing prior to closing.",
  },
  {
    n: 2, id: "property", title: "Property",
    body:
      "Seller agrees to sell and Buyer agrees to buy the real property commonly known as " +
      "{{address}}, {{county}} County, Washington, Tax Parcel No. {{apn}}, legally described as:",
    legalBlock: true,
    bodyAfter:
      'together with all improvements, fixtures, and appurtenances (the "Property"). If the legal ' +
      "description above is incomplete or contains an error, the parties agree to execute a " +
      "corrective amendment supplying the description of record, and the Closing Agent is " +
      "authorized to insert the description of record.",
  },
  {
    n: 3, id: "price", title: "Purchase Price",
    body:
      'The total purchase price is {{price}} ({{price_words}}) (the "Purchase Price"), payable in ' +
      "cash or immediately available funds at closing. This Agreement is not contingent upon Buyer " +
      "obtaining financing or upon any appraisal.",
  },
  {
    n: 4, id: "earnest", title: "Earnest Money",
    body:
      "Buyer will deposit earnest money of {{earnest_money}} with the Closing Agent within three (3) " +
      "business days after Mutual Acceptance. Earnest money is held in escrow by the Closing Agent " +
      "and is applied to the Purchase Price at closing. Earnest money is refundable to Buyer if this " +
      "Agreement terminates under § 6 (Feasibility) or any other termination right expressly granted " +
      "to Buyer, and becomes non-refundable only upon expiration of the Feasibility Period without " +
      "termination.",
    bodyShortSale:
      "Buyer will deposit earnest money of {{earnest_money}} with the Closing Agent within three (3) " +
      "business days after Mutual Acceptance. Earnest money is held in escrow by the Closing Agent " +
      "and is applied to the Purchase Price at closing. Earnest money is refundable to Buyer if this " +
      "Agreement terminates under § 6 (Feasibility), Addendum B (Lienholder Approval), or any other " +
      "termination right expressly granted to Buyer, and becomes non-refundable only upon expiration " +
      "of the Feasibility Period without termination.",
  },
  {
    n: 5, id: "closing", title: "Closing and Closing Agent",
    body:
      'Closing will occur at {{title_company}} (the "Closing Agent"), {{title_officer}}, ' +
      '{{title_phone}}, on or before {{closing_date}} (the "Closing Date"). Closing means the date ' +
      "the deed is recorded and sale proceeds are available to Seller.",
    bodyShortSale:
      'Closing will occur at {{title_company}} (the "Closing Agent"), {{title_officer}}, ' +
      "{{title_phone}}, on or before the date that is {{closing_days}} days after Buyer's receipt of " +
      "written approval of this transaction from all lienholders of record, or {{backstop_date}}, " +
      'whichever is later (the "Closing Date"). Closing means the date the deed is recorded and sale ' +
      "proceeds are available to Seller.",
  },
  {
    n: 6, id: "feasibility", title: "Feasibility and Inspection Contingency",
    body:
      "Buyer's obligations are contingent on Buyer's satisfaction, in Buyer's sole and absolute " +
      "discretion, with all aspects of the Property, including its physical condition, title, zoning, " +
      "permitting, utilities, and economic feasibility. Buyer and Buyer's agents, contractors, and " +
      "prospective assignees may enter the Property at reasonable times to inspect, test, photograph, " +
      "and measure, upon reasonable notice to Seller.\n\n" +
      "The Feasibility Period runs for {{feasibility_days}} days beginning on the date of Mutual " +
      "Acceptance. Buyer may terminate this Agreement for any reason or no reason by written notice " +
      "delivered to Seller and the Closing Agent before the Feasibility Period expires, whereupon all " +
      "earnest money is promptly refunded to Buyer and neither party has further obligation to the " +
      "other. If Buyer does not deliver a termination notice before the Feasibility Period expires, " +
      "this contingency is waived.\n\n" +
      "Buyer will restore any physical damage to the Property caused by Buyer's inspections and will " +
      "indemnify Seller against liens or claims arising from work performed at Buyer's direction.",
    bodyShortSale:
      "Buyer's obligations are contingent on Buyer's satisfaction, in Buyer's sole and absolute " +
      "discretion, with all aspects of the Property, including its physical condition, title, zoning, " +
      "permitting, utilities, and economic feasibility. Buyer and Buyer's agents, contractors, and " +
      "prospective assignees may enter the Property at reasonable times to inspect, test, photograph, " +
      "and measure, upon reasonable notice to Seller.\n\n" +
      "The Feasibility Period runs for {{feasibility_days}} days beginning on the date Buyer receives " +
      "written lienholder approval under Addendum B. Buyer may terminate this Agreement for any reason " +
      "or no reason by written notice delivered to Seller and the Closing Agent before the Feasibility " +
      "Period expires, whereupon all earnest money is promptly refunded to Buyer and neither party has " +
      "further obligation to the other. If Buyer does not deliver a termination notice before the " +
      "Feasibility Period expires, this contingency is waived.\n\n" +
      "Buyer will restore any physical damage to the Property caused by Buyer's inspections and will " +
      "indemnify Seller against liens or claims arising from work performed at Buyer's direction.",
  },
  {
    n: 7, id: "as_is", title: "Condition of Property — As-Is",
    body:
      "Buyer is purchasing the Property strictly AS-IS, WHERE-IS, with all faults. Seller has no " +
      "obligation to make or pay for any repair, replacement, remediation, cleaning, treatment, " +
      "inspection, certification, or improvement of any kind. Further terms are set out in Addendum A, " +
      "which is incorporated by reference.",
  },
  {
    n: 8, id: "title", title: "Title",
    body:
      "Seller will convey fee simple title by statutory warranty deed (or, if Seller is a fiduciary or " +
      "lender, by the form of deed customary for such Seller), free of liens and encumbrances except " +
      "easements, restrictions, and reservations of record that do not materially interfere with " +
      "Buyer's intended use, and current-year taxes not yet due. Seller will pay for and deliver a " +
      "standard coverage owner's policy of title insurance in the amount of the Purchase Price. Buyer " +
      "may obtain extended coverage and any endorsements at Buyer's expense. Title objections are " +
      "addressed within the Feasibility Period under § 6.",
  },
  {
    n: 9, id: "costs", title: "Closing Costs, Prorations, and Excise Tax",
    body:
      "Seller pays: the Washington real estate excise tax under RCW ch. 82.45 and any local excise " +
      "tax; the standard owner's title policy premium; one-half of the escrow fee; recording fees for " +
      "instruments clearing title; all outstanding liens, judgments, utility balances, and assessments " +
      "through closing; and any brokerage compensation Seller has separately agreed to pay its own " +
      "listing broker. Buyer pays: one-half of the escrow fee; recording of the deed; and Buyer's own " +
      "lender, inspection, and title endorsement costs. Real property taxes, HOA dues, and any " +
      "assessments are prorated as of the Closing Date.",
    bodyShortSale:
      "Seller pays: the Washington real estate excise tax under RCW ch. 82.45 and any local excise " +
      "tax; the standard owner's title policy premium; one-half of the escrow fee; recording fees for " +
      "instruments clearing title; all outstanding liens, judgments, utility balances, and assessments " +
      "through closing; and any brokerage compensation Seller has separately agreed to pay its own " +
      "listing broker. Buyer pays: one-half of the escrow fee; recording of the deed; and Buyer's own " +
      "lender, inspection, and title endorsement costs. Real property taxes, HOA dues, and any " +
      "assessments are prorated as of the Closing Date. If this is a short sale, all Seller-side costs " +
      "are payable from sale proceeds and Buyer will make no contribution toward them unless " +
      "separately agreed in a signed amendment.",
  },
  {
    n: 10, id: "possession", title: "Possession",
    body:
      "Seller delivers possession to Buyer at closing, free of tenants and occupants unless otherwise " +
      "disclosed in writing and accepted by Buyer during the Feasibility Period. Seller will not enter " +
      "into, extend, or modify any lease or occupancy agreement after Mutual Acceptance without " +
      "Buyer's written consent.",
  },
  {
    n: 11, id: "form17", title: "Seller Disclosure Statement (RCW ch. 64.06)",
    body:
      "Unless this transaction is exempt under RCW 64.06.010, Seller will deliver to Buyer a completed " +
      'Real Property Transfer Disclosure Statement ("Form 17") within five (5) business days after ' +
      "Mutual Acceptance. Buyer has three (3) business days after receipt to rescind this Agreement by " +
      "written notice, in which case all earnest money is refunded to Buyer. Buyer does not waive the " +
      "right to receive Form 17.",
  },
  {
    n: 12, id: "lead_paint", title: "Lead-Based Paint Disclosure",
    body:
      "If any residential dwelling on the Property was constructed before 1978, Seller will deliver " +
      'the federally required lead-based paint disclosure and the pamphlet "Protect Your Family From ' +
      'Lead In Your Home" before Buyer is obligated under this Agreement. Buyer\'s ten-day opportunity ' +
      "to conduct a lead-based paint assessment runs concurrently with the Feasibility Period under § 6.",
  },
  {
    n: 13, id: "firpta", title: "FIRPTA",
    body:
      'If Seller is a "foreign person" under Internal Revenue Code § 1445, Buyer or the Closing Agent ' +
      "will withhold and remit the amount required by law from sale proceeds. Seller will deliver a " +
      "certificate of non-foreign status at or before closing if applicable.",
  },
  {
    n: 14, id: "assignment", title: "Assignment and Buyer's Investor Status",
    body:
      "Buyer is a real estate investor purchasing as a principal for Buyer's own account. Buyer " +
      "discloses that Buyer may sell, transfer, or assign Buyer's equitable interest in this Agreement " +
      "to an affiliated entity or a third-party purchaser prior to closing, and may realize a profit " +
      "on that assignment. Buyer may do so without Seller's further consent and without compensation " +
      "to Seller beyond the Purchase Price. Buyer remains responsible for performance under this " +
      "Agreement unless released in writing by Seller. Buyer is not a licensed real estate broker, is " +
      "not representing Seller or any other party, and is not providing brokerage services in this " +
      "transaction.\n\n" +
      "If any title condition or deed restriction of record prohibits or conditions assignment or " +
      "resale, Buyer will comply with it or terminate under § 6.",
    bodyShortSale:
      "Buyer is a real estate investor purchasing as a principal for Buyer's own account. Buyer " +
      "discloses that Buyer may sell, transfer, or assign Buyer's equitable interest in this Agreement " +
      "to an affiliated entity or a third-party purchaser prior to closing, and may realize a profit " +
      "on that assignment. Buyer may do so without Seller's further consent and without compensation " +
      "to Seller beyond the Purchase Price. Buyer remains responsible for performance under this " +
      "Agreement unless released in writing by Seller. Buyer is not a licensed real estate broker, is " +
      "not representing Seller or any other party, and is not providing brokerage services in this " +
      "transaction.\n\n" +
      "If any lienholder approval, addendum, or deed restriction prohibits or conditions assignment or " +
      "resale, Buyer will comply with it or terminate under § 6 or Addendum B.",
  },
  {
    n: 15, id: "default", title: "Default and Remedies",
    body:
      "If Buyer defaults after all contingencies are waived or satisfied, Seller's sole and exclusive " +
      "remedy is to retain the earnest money as liquidated damages, the parties agreeing that actual " +
      "damages would be difficult to ascertain. If Seller defaults, Buyer may (a) recover the earnest " +
      "money and Buyer's actual out-of-pocket costs, or (b) seek specific performance, real property " +
      "being unique.",
  },
  {
    n: 16, id: "risk_of_loss", title: "Risk of Loss",
    body:
      "Risk of loss remains with Seller until closing. If the Property is materially damaged before " +
      "closing, Buyer may terminate this Agreement by written notice and receive a full refund of " +
      "earnest money, or proceed to closing and take an assignment of available insurance proceeds.",
  },
  {
    n: 17, id: "notices", title: "Notices",
    body:
      "All notices must be in writing and are effective when delivered by hand, by overnight courier, " +
      "or by email to the addresses below (or as updated in writing). Email to the addresses on the " +
      "signature page constitutes valid delivery.",
  },
  {
    n: 18, id: "time", title: "Mutual Acceptance, Time, and Computation of Periods",
    body:
      '"Mutual Acceptance" occurs on the date the last party signs or initials the final agreed terms ' +
      "and that signature is delivered to the other party. Time is of the essence. Periods stated in " +
      'days mean calendar days unless "business days" is specified; the day of the triggering act is ' +
      "not counted; if a period ends on a Saturday, Sunday, or Washington legal holiday, it extends to " +
      "the next business day. Any period stated in business days excludes Saturdays, Sundays, and " +
      "Washington legal holidays.",
  },
  {
    n: 19, id: "counterparts", title: "Counterparts and Electronic Signatures",
    body:
      "This Agreement may be signed in counterparts, each of which is an original. Electronic " +
      "signatures and signatures delivered by email or electronic transmission are valid and binding " +
      "under RCW ch. 1.80 (Uniform Electronic Transactions Act).",
  },
  {
    n: 20, id: "entire", title: "Entire Agreement, Governing Law, Venue, Attorney Fees",
    body:
      "This Agreement, together with the Addenda and Exhibits identified below, is the entire " +
      "agreement between the parties and supersedes all prior negotiations, letters of intent, and " +
      "understandings, written or oral. It may be amended only by a writing signed by both parties. " +
      "This Agreement is governed by the laws of the State of Washington, and venue for any dispute " +
      "lies in the Superior Court of {{county}} County, Washington. The prevailing party in any action " +
      "to enforce this Agreement is entitled to reasonable attorney fees and costs.",
  },
  {
    n: 21, id: "addenda", title: "Addenda and Exhibits Incorporated",
    // The exhibit sentence is appended by the renderer, which knows which
    // exhibits actually made it into the envelope.
    body: "Addendum A — As-Is Purchase, No Repairs, No Buyer Commission.",
    bodyShortSale:
      "Addendum A — As-Is Purchase, No Repairs, No Buyer Commission. " +
      "Addendum B — Short Sale / Third-Party Lienholder Approval Contingency.",
    incorporationSuffix: "Each is incorporated into this Agreement by this reference.",
  },
  {
    n: 22, id: "expiration", title: "Offer Expiration",
    body:
      "This offer is open for acceptance until {{offer_expires}} Pacific Time, after which it expires " +
      "unless extended by Buyer in writing.",
  },
];

// Operator-authored extra terms. Deliberately UNNUMBERED — inserting a numbered
// section would shift every cross-reference above it ("§ 6", "§ 9").
export const PSA_ADDITIONAL_TERMS_TITLE = "ADDITIONAL TERMS";
export const PSA_ADDITIONAL_TERMS_INTRO =
  "The following additional terms are agreed by the parties and control over any conflicting " +
  "provision of this Agreement:";

export const PSA_SIGNING_LINE = "The parties sign below as of the dates written.";

/* ================================ Addendum A ============================== */

export const ADDENDUM_A = {
  label: "ADDENDUM A",
  title: "As-Is Purchase — No Repairs — No Buyer Commission",
  intro:
    "This Addendum A is attached to and made part of the Purchase and Sale Agreement dated " +
    '{{effective_date}} between {{seller_name}} ("Seller") and {{buyer_entity}}, and/or assigns ' +
    '("Buyer"), for the property at {{address}} (the "Agreement"). If this Addendum conflicts with ' +
    "the Agreement, this Addendum controls.",
  clauses: [
    {
      id: "as_is", num: "A-1", title: "As-Is, Where-Is",
      body:
        "Buyer accepts the Property in its present condition, AS-IS, WHERE-IS, with all faults, latent " +
        "and patent, known and unknown. Buyer relies solely on Buyer's own inspections and " +
        "investigations conducted during the Feasibility Period and not on any representation of " +
        "Seller, any lienholder, or any broker as to the condition, value, square footage, boundaries, " +
        "systems, permits, or suitability of the Property.",
    },
    {
      id: "no_repairs", num: "A-2", title: "No Repairs or Credits",
      body:
        "Seller will make no repairs, replacements, or improvements to the Property and will provide " +
        "no repair credit, price reduction, holdback, or allowance in lieu of repairs. Buyer will not " +
        "request any repair, credit, or price adjustment based on the condition of the Property after " +
        "the Feasibility Period expires. Seller has no obligation to obtain any inspection, " +
        "certification, permit, occupancy approval, pest or septic report, or utility clearance.",
    },
    {
      id: "personal_property", num: "A-3", title: "Personal Property and Debris",
      body:
        "Seller may leave at the Property any personal property, fixtures, vehicles, appliances, " +
        "furnishings, or debris that Seller does not wish to remove. All such items convey to Buyer at " +
        "closing at no additional cost and with no warranty of any kind, and Buyer accepts full " +
        "responsibility for their removal and disposal at Buyer's expense. Seller will not be required " +
        "to clean the Property or deliver it in broom-clean condition. Seller warrants only that Seller " +
        "has the right to leave such items and that no third party holds a security interest in them.",
    },
    {
      id: "no_commission", num: "A-4", title: "No Buyer Brokerage Commission",
      body:
        "Buyer is unrepresented and acts as a principal in this transaction. No buyer brokerage " +
        "commission, buyer agency fee, or transaction fee is payable by Seller, by Buyer, by any " +
        "lienholder, or from closing proceeds. Nothing in this Addendum affects any compensation Seller " +
        "has separately agreed in writing to pay its own listing broker, which remains a Seller-side " +
        "cost under § 9 of the Agreement.",
    },
    {
      id: "utilities", num: "A-5", title: "Utilities and Access",
      body:
        "Seller will use reasonable efforts to keep existing utilities on through closing to permit " +
        "inspection, but Seller is not obligated to restore or activate utilities that are currently " +
        "off. If utilities are off, Buyer may activate them at Buyer's expense during the Feasibility " +
        "Period, at Buyer's risk.",
    },
    {
      id: "survival", num: "A-6", title: "Survival",
      body: "The provisions of this Addendum survive closing and delivery of the deed.",
    },
  ],
};

/* ================================ Addendum B ============================== */
// Short sale only. Every timeline in the Agreement keys off lienholder approval
// when this addendum is in play — see § 5, § 6 and B-5.

export const ADDENDUM_B = {
  label: "ADDENDUM B",
  title: "Short Sale — Third-Party Lienholder Approval Contingency",
  intro:
    "This Addendum B is attached to and made part of the Purchase and Sale Agreement dated " +
    '{{effective_date}} for the property at {{address}} (the "Agreement"). If this Addendum conflicts ' +
    "with the Agreement, this Addendum controls.",
  clauses: [
    {
      id: "contingency", num: "B-1", title: "Contingency",
      body:
        "This Agreement is contingent upon written approval of this sale, on the terms stated in the " +
        "Agreement, by every holder of a lien, mortgage, deed of trust, judgment, or other encumbrance " +
        "of record against the Property, together with any mortgage insurer or investor whose consent " +
        'is required (each a "Lienholder"). Approval must permit the sale to close at the Purchase ' +
        "Price with no monetary contribution, promissory note, or post-closing obligation of any kind " +
        "from Buyer beyond the Purchase Price and Buyer's costs under § 9.",
    },
    {
      id: "seller_obligations", num: "B-2", title: "Seller's Obligations",
      body:
        "Seller will submit a complete short sale package to each Lienholder within five (5) business " +
        "days after Mutual Acceptance, will respond to Lienholder requests promptly, and will deliver " +
        "to Buyer a copy of each written approval, counter, denial, or condition within two (2) " +
        "business days of receipt. Seller will not accept a Lienholder condition that binds Buyer " +
        "without Buyer's written consent.",
    },
    {
      id: "deadline", num: "B-3", title: "Approval Deadline and Termination",
      body:
        "If Buyer has not received written approval from all Lienholders on or before " +
        "{{approval_deadline}}, either party may terminate this Agreement by written notice to the " +
        "other and to the Closing Agent, and all earnest money is promptly refunded to Buyer. Until a " +
        "terminating notice is delivered, the Agreement remains in effect.",
    },
    {
      id: "changed_terms", num: "B-4", title: "Changed Terms",
      body:
        "If any Lienholder approves on terms different from those in the Agreement — including a " +
        "different price, a different closing date, a required Buyer contribution, an anti-assignment " +
        "or resale restriction, a deed restriction or seasoning requirement, an arm's-length affidavit, " +
        "or any other new condition — those terms constitute a counteroffer. They bind Buyer only if " +
        "Buyer accepts them in a written amendment. If Buyer does not accept within {{counter_days}} " +
        "business days of receiving them, Buyer may terminate and receive a full refund of earnest money.",
    },
    {
      id: "timelines", num: "B-5", title: "Timelines Run From Approval",
      body:
        "The Feasibility Period under § 6 and the Closing Date under § 5 are measured from the date " +
        "Buyer receives written approval from all Lienholders, not from Mutual Acceptance. Earnest " +
        "money remains fully refundable to Buyer until the Feasibility Period expires.",
    },
    {
      id: "buyer_disclosure", num: "B-6", title: "Buyer's Disclosure",
      body:
        "Buyer discloses that Buyer is an investor buying at a price intended to allow a profit, and " +
        "that Buyer may assign this Agreement or resell the Property after closing. Buyer will execute " +
        "a customary arm's-length affidavit confirming that Buyer and Seller are not related and that " +
        "there is no agreement for Seller to remain in title or repurchase the Property. If a " +
        "Lienholder requires a restriction inconsistent with Buyer's disclosed intent, § B-4 applies.",
    },
    {
      id: "marketable", num: "B-7", title: "Property Remains Marketable",
      body:
        "Seller may continue to market the Property and accept backup offers during the approval " +
        "period. Seller will notify Buyer in writing if Seller accepts a backup offer.",
    },
  ],
};

/* ================================ Boilerplate ============================= */

// Printed once, at the very end. This is the piece that keeps the package
// honest: it is a principal's own form, not an association form, and nobody
// here is a lawyer.
export const PSA_CLOSING_DISCLAIMER =
  "This document was prepared by Buyer, a principal to this transaction, for Buyer's own use. It is " +
  "not a Northwest Multiple Listing Service form, a Washington REALTORS® form, or a form promulgated " +
  "by any governmental body, and no such organization endorses it. Buyer is not an attorney and is " +
  "not providing legal advice. Each party is advised to have this document reviewed by independent " +
  "legal counsel before signing.";

export const PSA_FOOTER_PREFIX = "Purchase and Sale Agreement";

// The addenda a mode ships with, in order.
export function psaAddenda(mode) {
  return mode === "short_sale" ? [ADDENDUM_A, ADDENDUM_B] : [ADDENDUM_A];
}

// The sections a mode ships with, with the mode's body already selected.
export function psaSections(mode) {
  const short = mode === "short_sale";
  return PSA_SECTIONS
    .filter((s) => !s.modes || s.modes.includes(mode))
    .map((s) => ({ ...s, body: (short && s.bodyShortSale) || s.body }));
}
