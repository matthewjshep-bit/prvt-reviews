// comps-grade.js — renovation condition for a set of sold comps.
//
// ARV means AFTER-repair value, so it has to be derived from comps that were
// themselves renovated. Nothing in a county record says whether a house had a
// new kitchen when it sold, so this pulls each comp's sold listing photos and
// asks Claude — see gradeCompConditions in rehab-scan.js for the grading rubric.
//
// Extracted from the POST /comps/grade route so the auto-underwrite pipeline
// and the Comps pane share one cache and one implementation. The cache is the
// point: a sold house's condition is immutable, so a grade is good for a week,
// and the operator grading the same neighborhood twice in an afternoon pays
// Apify once.

import { fetchZillowPhotos, gradeCompConditions } from "./rehab-scan.js";
import { mapPool } from "./map-pool.js";

const gradeCache = new Map(); // comp address → { ts, grade }
const GRADE_TTL = 7 * 24 * 3600 * 1000;
const cacheKey = (c) => String(c.address).trim().toLowerCase();

// Comps that a caller already has photos for (Zillow bookmarklet captures)
// cost one Claude call and zero Apify credits.
export const needsScrape = (comps) =>
  comps.some((c) => !(Array.isArray(c.photos) && c.photos.length));

/**
 * gradeComps({ subjectAddress, comps, aiApiKey, apifyToken })
 *
 *   comps  [{ id, address, price?, sqft?, beds?, baths?, saleDate?, photos?, description? }]
 *
 * Returns { grades: { [id]: {condition, confidence, note, cached?} }, failed: [{id, reason}] }.
 * A comp whose listing can't be pulled is graded "unknown" rather than dropped —
 * the caller needs to know it was tried and why it didn't work.
 */
export async function gradeComps({ subjectAddress, comps, aiApiKey, apifyToken }) {
  const grades = {};
  const failed = [];

  const uncached = [];
  for (const c of comps) {
    const hit = gradeCache.get(cacheKey(c));
    if (hit && Date.now() - hit.ts < GRADE_TTL) grades[c.id] = { ...hit.grade, cached: true };
    else uncached.push(c);
  }

  const fetched = await mapPool(uncached, 3, async (c) => {
    if (Array.isArray(c.photos) && c.photos.length) {
      return { ...c, photos: c.photos.slice(0, 6), description: String(c.description || "").slice(0, 1500) };
    }
    try {
      const z = await fetchZillowPhotos(c.address, apifyToken);
      if (!z.photos.length) throw new Error("no photos on the listing");
      return { ...c, photos: z.photos.slice(0, 6), description: z.listing?.remarks || "" };
    } catch (e) {
      const reason = e.message.slice(0, 120);
      grades[c.id] = { condition: "unknown", confidence: "low", note: `Couldn't pull listing photos (${reason})` };
      failed.push({ id: c.id, reason });
      return null;
    }
  });

  const gradeable = fetched.filter(Boolean);
  if (gradeable.length) {
    const result = await gradeCompConditions({ subjectAddress, comps: gradeable, aiApiKey });
    for (const g of result.grades || []) {
      const comp = gradeable.find((c) => c.id === g.id);
      if (!comp) continue;
      const grade = { condition: g.condition, confidence: g.confidence, note: g.note };
      grades[g.id] = grade;
      // Cache only grades backed by real photos — scrape failures stay retryable.
      if (gradeCache.size > 200) gradeCache.clear();
      gradeCache.set(cacheKey(comp), { ts: Date.now(), grade });
    }
  }

  return { grades, failed };
}
