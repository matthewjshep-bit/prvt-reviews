// google.js — Helper functions for the Google Business Profile APIs.

/**
 * Fetch all accounts the user has access to.
 */
export async function getGoogleAccounts(accessToken) {
  const res = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("Failed to fetch Google accounts:", err);
    throw new Error("Failed to fetch Google accounts");
  }
  const data = await res.json();
  return data.accounts || [];
}

/**
 * Fetch all locations under a specific account.
 */
export async function getGoogleLocations(accessToken, accountName) {
  // readMask is required for Business Information API locations.list
  const res = await fetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("Failed to fetch Google locations:", err);
    throw new Error("Failed to fetch Google locations");
  }
  const data = await res.json();
  return data.locations || [];
}

/**
 * Fetch reviews for a specific location.
 * The v4 API is still used for reviews.
 */
export async function getGoogleReviews(accessToken, accountId, locationId) {
  // accountId is the numeric ID (e.g. 123456789), locationId is the numeric ID
  // The API expects: accounts/{accountId}/locations/{locationId}/reviews
  const res = await fetch(
    `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("Failed to fetch Google reviews:", err);
    throw new Error("Failed to fetch Google reviews");
  }
  const data = await res.json();
  return {
    reviews: data.reviews || [],
    averageRating: data.averageRating || 0,
    totalReviewCount: data.totalReviewCount || 0,
  };
}
