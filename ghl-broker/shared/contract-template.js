// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// contract-template.js — the wholesale-friendly contract templates: the
// Purchase & Sale Agreement (seller-facing) and the Assignment of Contract
// Agreement (dispositions/buyer-facing). Default clause language, the
// placeholder tokens each may reference, and the merge helper that fills
// tokens (or prints a signable blank line).
//
// Shared by the broker (PDF rendering in contract-pdf.js) and the frontend
// (Settings clause editor + token legend). Pure data + string functions.
//
// Clause numbering is POSITIONAL — clauses render as `index + 1`, so reordering
// in Settings never desyncs the numbers. Consequence: clause bodies must
// cross-reference other clauses by NAME ("under the Inspection Period
// paragraph"), never by number.

// Every placeholder a clause body may use, written as {{key}}. When the field
// is left empty the token prints as a blank underscore run of blankWidth
// characters (a fill-in-by-hand line), so a partially completed contract is
// still printable and signable.
export const CONTRACT_TOKENS = [
  { key: "effective_date", label: "Effective date", blankWidth: 18 },
  { key: "buyer_name", label: "Buyer / entity", blankWidth: 30 },
  { key: "seller_name", label: "Seller", blankWidth: 30 },
  { key: "address", label: "Property address", blankWidth: 40 },
  { key: "price", label: "Purchase price", blankWidth: 14 },
  { key: "price_words", label: "Price in words", blankWidth: 40 },
  { key: "earnest_money", label: "Earnest money", blankWidth: 12 },
  { key: "inspection_days", label: "Inspection days", blankWidth: 5 },
  { key: "closing_date", label: "Closing date", blankWidth: 18 },
  { key: "title_company", label: "Title company", blankWidth: 30 },
  { key: "special_provisions", label: "Special provisions", blankWidth: 40 },
  { key: "state", label: "State", blankWidth: 14 },
  { key: "county", label: "County", blankWidth: 18 },
];

// Printed small under the heading — kept out of the editable clause list so it
// can't be deleted by accident.
export const CONTRACT_DISCLAIMER =
  "DISCLAIMER: This is a general-purpose template provided for convenience, not legal, tax, or " +
  "financial advice. We are not attorneys. Real estate laws vary by state. Have this document " +
  "reviewed and customized by a licensed real estate attorney in the state where the property is " +
  "located before signing or using it.";

// The opening paragraph above the numbered clauses.
export const CONTRACT_PREAMBLE =
  'This Agreement ("Agreement") is entered into as of {{effective_date}} ("Effective Date") ' +
  'between {{seller_name}} ("Seller") and {{buyer_name}} ("Buyer").';

// Default clause language (wholesale-friendly: cash, as-is, freely assignable).
// `id` is a stable key for editor rows and reset detection only — the printed
// number is the clause's position in the list.
export const DEFAULT_CONTRACT_CLAUSES = [
  {
    id: "property",
    title: "Property",
    body:
      "Seller agrees to sell and Buyer agrees to purchase the real property located at " +
      '{{address}} (the "Property"), together with all improvements and fixtures.',
  },
  {
    id: "price",
    title: "Purchase Price",
    body: "The total purchase price shall be {{price}} ({{price_words}}), payable in cash at Closing.",
  },
  {
    id: "earnest",
    title: "Earnest Money",
    body:
      "Buyer shall deposit {{earnest_money}} with {{title_company}} (the \"Title Company\"), due " +
      "after the Inspection Period. Earnest Money shall be applied to the Purchase Price at " +
      "Closing or refunded if this Agreement is terminated under the Inspection Period.",
  },
  {
    id: "inspection",
    title: "Inspection Period",
    body:
      "Buyer shall have {{inspection_days}} days from the Effective Date to inspect the Property. " +
      "Buyer may terminate this Agreement for any reason during this period by written notice to " +
      "Seller, including email/text, and Earnest Money shall be refunded.",
  },
  {
    id: "closing",
    title: "Closing",
    body:
      'Closing shall occur on or before {{closing_date}} ("Closing Date"). At Closing, Seller ' +
      "shall deliver marketable title, free of all liens and encumbrances except as disclosed and " +
      "accepted by Buyer, and Buyer shall deliver the balance of the Purchase Price. Closing " +
      "costs shall be paid by Buyer.",
  },
  {
    id: "as_is",
    title: "As-Is Condition",
    body:
      "The Property is sold in its present, \"as-is\" condition, subject to Buyer's inspection rights.",
  },
  {
    id: "assignment",
    title: "Assignment",
    body:
      "Buyer may assign this Agreement without Seller's further consent or compensation. Buyer " +
      "shall remain responsible for performance under this Agreement if the assignee fails to " +
      "perform.",
  },
  {
    id: "time_essence",
    title: "Time Is of the Essence",
    body: "All dates and deadlines in this Agreement are material. Failure to timely perform is a breach.",
  },
  {
    id: "default_remedies",
    title: "Default & Remedies",
    body:
      "If Seller defaults, Buyer may terminate with refund of Earnest Money, recover option " +
      "costs, or seek specific performance or damages. If Buyer defaults, Seller may terminate " +
      "and keep the Earnest Money. The prevailing party is entitled to attorney's fees.",
  },
  {
    id: "reps_warranties",
    title: "Representations & Warranties",
    body:
      "Seller represents that it owns the Property, has authority to sell, and that title will be " +
      "free of liens except as disclosed.",
  },
  {
    id: "notices",
    title: "Notices",
    body:
      "Notices must be in writing and are deemed delivered when personally delivered, delivered " +
      "by courier, or sent by email with confirmation.",
  },
  {
    id: "special",
    title: "Special Provisions",
    body: "{{special_provisions}}",
  },
  {
    id: "governing_law",
    title: "Governing Law and Venue",
    body:
      "This Agreement shall be governed by the laws of the State of {{state}}, the state in which " +
      "the Property is located. Unless otherwise required by law, any legal proceeding relating " +
      "to this Agreement shall be brought in {{county}} County, the county where the Property is " +
      "located.",
  },
  {
    id: "general",
    title: "General Provisions",
    body:
      "This Agreement contains the entire agreement between the parties and may be amended only " +
      "by a written agreement signed by both parties. If any provision is held invalid or " +
      "unenforceable, the remaining provisions shall remain effective. This Agreement may be " +
      "executed in counterparts and by electronic signature, each of which shall be binding. This " +
      "Agreement shall bind and benefit the parties and their respective heirs, successors, and " +
      "permitted assigns.",
  },
  {
    id: "relationship",
    title: "Relationship of the Parties",
    body:
      "Buyer is acting solely as a principal for Buyer's own account and is not acting as " +
      "Seller's agent, broker, fiduciary, partner, joint venturer, or advisor. Seller has not " +
      "relied upon Buyer for legal, tax, financial, or real estate advice.",
  },
];

/* ======================= Assignment of Contract ========================== */
// The dispositions-side document: assigns the Purchase & Sale contract to the
// end buyer (Assignee). Goes to the person BUYING the deal — never the seller.

export const ASSIGNMENT_TOKENS = [
  { key: "effective_date", label: "Agreement date", blankWidth: 18 },
  { key: "assignor_name", label: "Assignor (you)", blankWidth: 30 },
  { key: "assignor_company", label: "Assignor company", blankWidth: 30 },
  { key: "assignee_name", label: "Assignee / buyer", blankWidth: 30 },
  { key: "assignee_company", label: "Assignee company", blankWidth: 30 },
  { key: "address", label: "Property address", blankWidth: 40 },
  { key: "total_price", label: "Total purchase price", blankWidth: 14 },
  { key: "total_price_words", label: "Total price in words", blankWidth: 40 },
  { key: "deposit", label: "Deposit", blankWidth: 12 },
  { key: "deposit_due_date", label: "Deposit due", blankWidth: 18 },
  { key: "closing_date", label: "Closing date", blankWidth: 18 },
];

// The opening paragraph above the numbered clauses.
export const ASSIGNMENT_PREAMBLE =
  'This Assignment Agreement ("Agreement") is made as of {{effective_date}} by and between ' +
  '{{assignor_name}} ("Assignor") and {{assignee_name}} ("Assignee"), regarding the real ' +
  'property located at {{address}} (the "Property").';

export const DEFAULT_ASSIGNMENT_CLAUSES = [
  {
    id: "original_contract",
    title: "Original Contract",
    body:
      "Assignor has a purchase contract with the current owner/seller of the Property (the " +
      '"Original Contract"). Assignor now agrees to assign its rights in the Original Contract ' +
      "to Assignee.",
  },
  {
    id: "assignment_price",
    title: "Assignment Price",
    body:
      "Assignee agrees to pay a total purchase price of {{total_price}} ({{total_price_words}}). " +
      "This amount includes the purchase price under the Original Contract plus Assignor's " +
      "assignment fee.",
  },
  {
    id: "deposit",
    title: "Deposit",
    body:
      "Assignee agrees to pay Assignor a deposit of {{deposit}}, due on or before " +
      "{{deposit_due_date}}. The deposit is non-refundable if Assignee backs out, fails to " +
      "close, or does not perform. However, if the deal cannot close for reasons outside of " +
      "Assignee's control, such as bad title or the seller being unable to convey the Property, " +
      "the deposit shall be refunded.",
  },
  {
    id: "closing",
    title: "Closing Date",
    body: "Closing shall take place on or before {{closing_date}}.",
  },
  {
    id: "closing_costs",
    title: "Closing Costs",
    body: "Assignee agrees to pay all closing costs unless otherwise agreed in writing.",
  },
  {
    id: "assignment",
    title: "Assignment",
    body:
      "Assignor assigns all rights, title, and interest in the Original Contract to Assignee. " +
      "Assignee accepts the assignment and agrees to complete the purchase according to the " +
      "Original Contract.",
  },
  {
    id: "accepts_contract",
    title: "Buyer Accepts the Contract",
    body:
      "Assignee confirms they have reviewed the Original Contract and accepts all of its terms. " +
      "Assignee agrees to perform all buyer obligations under the Original Contract.",
  },
  {
    id: "as_is",
    title: "As-Is Property",
    body:
      "Assignee accepts the Property in AS-IS condition. Assignor makes no promises or " +
      "warranties about the Property's condition, repairs, value, square footage, permits, " +
      "utilities, zoning, or any other property details. Assignee is responsible for doing " +
      "their own due diligence.",
  },
  {
    id: "no_financing",
    title: "No Financing Contingency",
    body:
      "This is a cash or hard money transaction. Assignee's obligation to close is not " +
      "contingent on financing, inspections, appraisal, or resale of the Property.",
  },
  {
    id: "no_marketing",
    title: "No Marketing",
    body:
      "Assignee may not publicly market, advertise, post, blast, or resell the Property without " +
      "Assignor's written permission. This includes, but is not limited to, Facebook, " +
      "InvestorLift, email blasts, SMS blasts, websites, or buyer groups.",
  },
  {
    id: "no_reassignment",
    title: "No Re-Assignment Without Permission",
    body:
      "Assignee may not assign this Agreement or the Original Contract to another buyer without " +
      "written permission from Assignor. If Assignee violates this section, Assignor may keep " +
      "the assignment fee and/or pursue damages.",
  },
  {
    id: "failure_to_close",
    title: "Failure to Close",
    body:
      "If Assignee fails to close or otherwise defaults, Assignor may keep the deposit as " +
      "liquidated damages. Assignor may also step back into the Original Contract and pursue " +
      "any additional legal remedies available.",
  },
  {
    id: "no_ownership",
    title: "Assignor Does Not Own the Property",
    body:
      "Assignee understands that Assignor does not currently own the Property. Assignor only " +
      "has a contractual interest in the Property through the Original Contract.",
  },
  {
    id: "entire_agreement",
    title: "Entire Agreement",
    body:
      "This Agreement is the full agreement between the parties. Any changes must be in " +
      "writing and signed by both parties.",
  },
  {
    id: "esignatures",
    title: "Electronic Signatures",
    body: "Electronic signatures are valid and may be used to sign this Agreement.",
  },
];

// Fill {{token}} placeholders from a values map. Empty/missing values print as
// an underscore blank sized by the token's blankWidth (unknown tokens get 20).
// Values are pre-formatted by the caller (money, dates, words). Pass the token
// list matching the document (CONTRACT_TOKENS or ASSIGNMENT_TOKENS) so blanks
// come out the right width.
export function mergeTokens(body, values = {}, tokens = CONTRACT_TOKENS) {
  return String(body || "").replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = values[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
    const tok = tokens.find((t) => t.key === key);
    return "_".repeat(tok?.blankWidth || 20);
  });
}
