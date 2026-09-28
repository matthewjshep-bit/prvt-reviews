// gmail-api.js — the few Gmail REST calls the sync needs, over plain fetch.
//
// One Workspace inbox, one refresh token from the env (made once with
// scripts/gmail-auth.mjs; the OAuth client is "Internal", so the token does
// not expire and Google never reviews the app). The scope is
// gmail.readonly: nothing here can send, label or delete.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export function gmailEnv(env = process.env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || "").trim();
  const refreshToken = String(env.GMAIL_REFRESH_TOKEN || "").trim();
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

const httpError = (status, what) => Object.assign(new Error(`gmail ${what}: HTTP ${status}`), { status });

let cached = null;   // { key, token, expiresAt }
export function _resetToken() { cached = null; }

export async function accessToken(creds, { now = Date.now() } = {}) {
  const key = `${creds.clientId}|${creds.refreshToken.slice(-8)}`;
  if (cached && cached.key === key && cached.expiresAt - 60000 > now) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: "refresh_token" }).toString(),
  });
  if (!res.ok) throw httpError(res.status, "token refresh");
  const j = await res.json();
  cached = { key, token: j.access_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000 };
  return cached.token;
}

/** makeGmail(creds) → { profile, history, list, message } */
export function makeGmail(creds, { timeoutMs = 20000 } = {}) {
  const call = async (path, what) => {
    const token = await accessToken(creds);
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw httpError(res.status, what);
    return res.json();
  };
  return {
    profile: () => call("/profile", "profile"),
    // Message ids added since startHistoryId, every page. A 404 means the id
    // is too old for Gmail to replay; the caller falls back to a search.
    async history(startHistoryId, { maxPages = 10 } = {}) {
      const ids = [];
      let pageToken = "";
      let historyId = String(startHistoryId);
      for (let i = 0; i < maxPages; i++) {
        const q = new URLSearchParams({ startHistoryId: String(startHistoryId), historyTypes: "messageAdded", maxResults: "500" });
        if (pageToken) q.set("pageToken", pageToken);
        const j = await call(`/history?${q}`, "history");
        if (j.historyId) historyId = String(j.historyId);
        for (const h of j.history || []) for (const m of h.messagesAdded || []) if (m.message?.id) ids.push(m.message.id);
        if (!j.nextPageToken) return { ids: [...new Set(ids)], historyId, complete: true };
        pageToken = j.nextPageToken;
      }
      return { ids: [...new Set(ids)], historyId, complete: false };
    },
    async list(q, { max = 300 } = {}) {
      const ids = [];
      let pageToken = "";
      while (ids.length < max) {
        const p = new URLSearchParams({ q, maxResults: String(Math.min(500, max - ids.length)) });
        if (pageToken) p.set("pageToken", pageToken);
        const j = await call(`/messages?${p}`, "list");
        for (const m of j.messages || []) ids.push(m.id);
        if (!j.nextPageToken) break;
        pageToken = j.nextPageToken;
      }
      return ids;
    },
    message: (id) => call(`/messages/${encodeURIComponent(id)}?format=full`, "message"),
  };
}
