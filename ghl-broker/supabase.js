// supabase.js — Supabase client + Google token persistence functions.
// Uses the SERVICE-ROLE key (server-side only, bypasses RLS).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "⚠  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — Google token persistence disabled."
  );
}

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

// ---------------------------------------------------------------------------
// saveGoogleConnection — upsert keyed on location_id
// ---------------------------------------------------------------------------
export async function saveGoogleConnection(
  locationId,
  { accessToken, refreshToken, expiry, googleAccountId, googleLocationId }
) {
  if (!supabase) throw new Error("Supabase not configured");

  const { error } = await supabase.from("google_connections").upsert(
    {
      location_id: locationId,
      google_access_token: accessToken,
      google_refresh_token: refreshToken,
      access_token_expiry: new Date(expiry).toISOString(),
      google_account_id: googleAccountId || null,
      google_location_id: googleLocationId || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "location_id" }
  );

  if (error) {
    console.error("saveGoogleConnection failed:", error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// getGoogleConnection — returns the row or null
// ---------------------------------------------------------------------------
export async function getGoogleConnection(locationId) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("google_connections")
    .select("*")
    .eq("location_id", locationId)
    .maybeSingle();

  if (error) {
    console.error("getGoogleConnection failed:", error.message);
    throw error;
  }
  return data; // null when no row
}

// ---------------------------------------------------------------------------
// getValidGoogleAccessToken — returns a usable access token or null
// ---------------------------------------------------------------------------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

export async function getValidGoogleAccessToken(locationId) {
  const row = await getGoogleConnection(locationId);
  if (!row) return null;

  // If the token expires more than 60 s from now, it's still valid.
  const expiresAt = new Date(row.access_token_expiry).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return row.google_access_token;
  }

  // --- Refresh the access token ---
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error("Cannot refresh Google token: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");
    return null;
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: row.google_refresh_token,
      }),
    });

    const body = await res.json();

    if (!res.ok) {
      // If the refresh token has been revoked / expired → delete the row
      // so the UI falls back to "Connect Google".
      if (body.error === "invalid_grant") {
        console.warn(
          `Google refresh token revoked for location ${locationId} — deleting connection.`
        );
        await supabase
          .from("google_connections")
          .delete()
          .eq("location_id", locationId);
        return null;
      }
      console.error("Google token refresh failed:", body.error, body.error_description);
      return null;
    }

    // Persist the new access token + expiry. Google usually does NOT return a
    // new refresh token on a refresh call — keep the existing one.
    const newExpiry = new Date(Date.now() + body.expires_in * 1000).toISOString();
    const { error: updateErr } = await supabase
      .from("google_connections")
      .update({
        google_access_token: body.access_token,
        access_token_expiry: newExpiry,
        updated_at: new Date().toISOString(),
      })
      .eq("location_id", locationId);

    if (updateErr) {
      console.error("Failed to persist refreshed token:", updateErr.message);
    }

    return body.access_token;
  } catch (err) {
    console.error("Google token refresh error:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// setGoogleLocation — updates the googleAccountId and googleLocationId
// ---------------------------------------------------------------------------
export async function setGoogleLocation(locationId, googleAccountId, googleLocationId) {
  if (!supabase) throw new Error("Supabase not configured");
  
  const { error } = await supabase
    .from("google_connections")
    .update({
      google_account_id: googleAccountId,
      google_location_id: googleLocationId,
      updated_at: new Date().toISOString(),
    })
    .eq("location_id", locationId);

  if (error) {
    console.error("setGoogleLocation failed:", error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// deleteGoogleConnection — removes the token entirely
// ---------------------------------------------------------------------------
export async function deleteGoogleConnection(locationId) {
  if (!supabase) throw new Error("Supabase not configured");
  
  const { error } = await supabase
    .from("google_connections")
    .delete()
    .eq("location_id", locationId);

  if (error) {
    console.error("deleteGoogleConnection failed:", error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Opportunity Contacts Linking
// ---------------------------------------------------------------------------

export async function getLinkedContacts(opportunityId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("opportunity_contacts")
    .select("contact_id, contact_name, contact_email, contact_phone")
    .eq("opportunity_id", opportunityId);
    
  if (error) {
    console.error("getLinkedContacts failed:", error.message);
    return [];
  }
  return data;
}

export async function addLinkedContact(opportunityId, contact) {
  if (!supabase) throw new Error("Supabase not configured");
  const { error } = await supabase
    .from("opportunity_contacts")
    .upsert({
      opportunity_id: opportunityId,
      contact_id: contact.id,
      contact_name: contact.name,
      contact_email: contact.email,
      contact_phone: contact.phone
    }, { onConflict: "opportunity_id, contact_id" });

  if (error) {
    console.error("addLinkedContact failed:", error.message);
    throw error;
  }
}

export async function removeLinkedContact(opportunityId, contactId) {
  if (!supabase) throw new Error("Supabase not configured");
  const { error } = await supabase
    .from("opportunity_contacts")
    .delete()
    .eq("opportunity_id", opportunityId)
    .eq("contact_id", contactId);

  if (error) {
    console.error("removeLinkedContact failed:", error.message);
    throw error;
  }
}
