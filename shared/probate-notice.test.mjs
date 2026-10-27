// probate-notice.test.mjs — reading the attorney off a probate Notice to
// Creditors, in the layouts the legal newspapers print. Every name, firm,
// number and address below is made up.

import test from "node:test";
import assert from "node:assert/strict";
import { parseProbateNotice, splitNotices, parseNotices, probateCaseNo, noticeCounty, noticeDate } from "./probate-notice.js";

const BODY = "The personal representative named below has been appointed as personal representative of this estate. Any person having a claim against the decedent must, before the time the claim would be barred by any otherwise applicable statute of limitations, present the claim in the manner as provided in RCW 11.40.070 by serving on or mailing to the personal representative or the personal representative's attorney at the address stated below a copy of the claim and filing the original of the claim with the court in which the probate proceedings were commenced. The claim must be presented within the later of: (1) Thirty days after the personal representative served or mailed the notice to the creditor as provided under RCW 11.40.020(1)(c); or (2) four months after the date of first publication of the notice. If the claim is not presented within this time frame, the claim is forever barred, except as otherwise provided in RCW 11.40.051 and 11.40.060. This bar is effective as to claims against both the decedent's probate and nonprobate assets.";

// A big-city daily: the whole notice on one line.
const KING_ONE_LINE = `PROBATE NOTICE TO CREDITORS NO. 25-4-07311-2 SEA SUPERIOR COURT OF WASHINGTON FOR KING COUNTY In the Matter of the Estate of HAROLD T. EXAMPLE, Deceased. ${BODY} Date of First Publication: October 8, 2025 Personal Representative: Wendy Example Attorney for the Personal Representative: Paul Q. Counsel, WSBA #40123 Address for Mailing or Service: Counsel Estate Law PLLC, 1201 Third Avenue, Suite 2200, Seattle, WA 98101 (206) 555-0142 pcounsel@counselestatelaw.test Court of probate proceedings and cause number: King County Superior Court, 25-4-07311-2 SEA`;

// A county weekly: a label per line, in capitals.
const SNOHOMISH_LINES = `PROBATE NOTICE TO CREDITORS
IN THE SUPERIOR COURT OF THE STATE OF WASHINGTON IN AND FOR THE COUNTY OF SNOHOMISH
In re the Estate of
MARGARET ANNE SAMPLE,
Deceased.
No. 25-4-02044-31
${BODY}
DATE OF FILING COPY OF NOTICE TO CREDITORS with Clerk of Court: September 30, 2025
DATE OF FIRST PUBLICATION: 10/07/2025
PERSONAL REPRESENTATIVE: Robert Sample
ATTORNEY FOR PERSONAL REPRESENTATIVE: LINDA M. ADVOCATE, WSBA No. 28877
ADDRESS FOR MAILING OR SERVICE:
Advocate & Partners, P.S.
2930 Wetmore Ave., Ste. 9A
Everett, WA 98201
425.555.0199
Court of Probate Proceedings: Snohomish County Superior Court`;

// A personal representative with no lawyer: no gatekeeper on this estate.
const PIERCE_PRO_SE = `NOTICE TO CREDITORS SUPERIOR COURT OF WASHINGTON FOR PIERCE COUNTY Estate of DONALD PLACEHOLDER, Deceased. No. 25-4-01562-6 ${BODY} Date of First Publication: Oct. 1, 2025 Personal Representative: Carol Placeholder Address for Mailing or Service: 5512 S Example St, Tacoma, WA 98409`;

// Nonprobate: a notice agent instead of a personal representative.
const NONPROBATE = `NONPROBATE NOTICE TO CREDITORS No. 25-4-05110-1 KNT SUPERIOR COURT OF WASHINGTON FOR KING COUNTY In the Matter of the Estate of EVELYN DUMMY, Deceased. ${BODY} Date of First Publication: November 5, 2025 Notice Agent: Grace Dummy Attorney for Notice Agent: Sam Lawyer, WSBA #51234 Address for Mailing or Service: Lawyer Elder Law Group, 10900 NE 8th St, Suite 1000, Bellevue, WA 98004, (425) 555-0177`;

test("the attorney, the firm, the bar number and the office are read off a one-line King County notice", () => {
  const n = parseProbateNotice(KING_ONE_LINE);
  assert.equal(n.caseNo, "25-4-07311-2 SEA");
  assert.equal(n.county, "King");
  assert.equal(n.decedent, "Harold T. Example");
  assert.equal(n.pr, "Wendy Example");
  assert.equal(n.firstPublished, "2025-10-08");
  assert.equal(n.proSe, false);
  assert.equal(n.attorney.name, "Paul Q. Counsel");
  assert.equal(n.attorney.barNo, "40123");
  assert.equal(n.attorney.firm, "Counsel Estate Law PLLC");
  assert.equal(n.attorney.address.city, "Seattle");
  assert.equal(n.attorney.address.zip, "98101");
  assert.match(n.attorney.address.street, /^1201 Third Avenue/);
  assert.equal(n.attorney.phone, "2065550142");
  assert.equal(n.attorney.email, "pcounsel@counselestatelaw.test");
});

test("a notice with a label per line in capitals reads the same", () => {
  const n = parseProbateNotice(SNOHOMISH_LINES);
  assert.equal(n.caseNo, "25-4-02044-31");
  assert.equal(n.county, "Snohomish");
  assert.equal(n.decedent, "Margaret Anne Sample");
  assert.equal(n.pr, "Robert Sample");
  assert.equal(n.firstPublished, "2025-10-07");
  assert.equal(n.filed, "2025-09-30");
  assert.equal(n.attorney.name, "Linda M. Advocate");
  assert.equal(n.attorney.barNo, "28877");
  assert.equal(n.attorney.firm, "Advocate & Partners, P.S.");
  assert.equal(n.attorney.address.city, "Everett");
  assert.equal(n.attorney.phone, "4255550199");
});

test("a personal representative with no attorney has no gatekeeper", () => {
  const n = parseProbateNotice(PIERCE_PRO_SE);
  assert.equal(n.county, "Pierce");
  assert.equal(n.caseNo, "25-4-01562-6");
  assert.equal(n.pr, "Carol Placeholder");
  assert.equal(n.proSe, true);
  assert.equal(n.attorney, null);
  assert.equal(n.firstPublished, "2025-10-01");
});

test("a nonprobate notice reads the attorney for the notice agent", () => {
  const n = parseProbateNotice(NONPROBATE);
  assert.equal(n.nonprobate, true);
  assert.equal(n.county, "King");
  assert.equal(n.pr, "Grace Dummy");
  assert.equal(n.attorney.name, "Sam Lawyer");
  assert.equal(n.attorney.barNo, "51234");
  assert.equal(n.attorney.firm, "Lawyer Elder Law Group");
  assert.equal(n.attorney.address.city, "Bellevue");
  assert.equal(n.attorney.phone, "4255550177");
});

test("the form's own 'copy of notice to creditors' line doesn't start a new notice", () => {
  assert.equal(splitNotices(SNOHOMISH_LINES).length, 1);
});

test("a digest of many notices splits into one per estate, and an estate's three weekly runs count once", () => {
  const digest = [KING_ONE_LINE, SNOHOMISH_LINES, KING_ONE_LINE, PIERCE_PRO_SE, NONPROBATE].join("\n\n----\n\n");
  assert.equal(splitNotices(digest).length, 5);
  const all = parseNotices(digest);
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((n) => n.county), ["King", "Snohomish", "Pierce", "King"]);
});

test("text that isn't a notice to creditors reads as nothing", () => {
  assert.equal(parseProbateNotice("NOTICE OF TRUSTEE'S SALE … 123 Main St"), null);
  assert.deepEqual(parseNotices("Notice of public hearing on the budget"), []);
});

test("cause numbers, counties and dates in their usual spellings", () => {
  assert.equal(probateCaseNo("Cause No. 24-4-00981-7 knt"), "24-4-00981-7 KNT");
  assert.equal(probateCaseNo("No. 24-2-00981-7"), "", "a 2 is a civil case, not probate");
  assert.equal(noticeCounty("In the Superior Court of the State of Washington in and for Grays Harbor County"), "Grays Harbor");
  assert.equal(noticeCounty("Kitsap County Superior Court"), "Kitsap");
  assert.equal(noticeDate("Oct. 15, 2025"), "2025-10-15");
  assert.equal(noticeDate("3/4/26"), "2026-03-04");
});
