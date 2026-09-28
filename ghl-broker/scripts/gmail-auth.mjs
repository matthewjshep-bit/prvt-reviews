// gmail-auth.mjs — make the broker's Gmail refresh token, once.
//
//   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/gmail-auth.mjs
//
// Before running it, in Google Cloud (a project inside the Workspace org):
//   1. Enable the Gmail API.
//   2. OAuth consent screen → User type "Internal". Internal means no Google
//      review and a refresh token that doesn't expire.
//   3. Credentials → OAuth client ID → "Desktop app".
// It opens a consent page for gmail.readonly, catches the redirect on
// localhost, and prints GMAIL_REFRESH_TOKEN. Put that and the two GOOGLE_*
// values in the Render broker's env, then switch Gmail on in Conversation
// AI settings. Nothing is written to disk.

import http from "node:http";
import { exec } from "node:child_process";
import { GMAIL_SCOPE } from "../gmail-api.js";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Desktop-app OAuth client) first.");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const code = url.searchParams.get("code");
  if (!code) { res.end(url.searchParams.get("error") || "no code"); return; }
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }).toString(),
  });
  const j = await r.json();
  if (!j.refresh_token) {
    res.end("No refresh token came back. Revoke the app at myaccount.google.com/permissions and run this again.");
    console.error(`token exchange: HTTP ${r.status}${j.error ? ` ${j.error}` : ""}`);
  } else {
    res.end("Done. Close this tab and go back to the terminal.");
    console.log(`\nGMAIL_REFRESH_TOKEN=${j.refresh_token}\n`);
  }
  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const auth = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: "code", scope: GMAIL_SCOPE, access_type: "offline", prompt: "consent",
  })}`;
  console.log(`Opening the consent page. If it doesn't open, visit:\n${auth}\n`);
  exec(`open "${auth}"`);
});
