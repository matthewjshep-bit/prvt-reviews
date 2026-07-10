// crypto.js — AES-256-GCM encryption for connection secrets (§4). The key comes
// from env CONNECTIONS_KEY (any length; SHA-256 derives a 32-byte key). Secrets
// are decrypted only inside the provider execution path and never returned by
// any API.

import crypto from "node:crypto";

const SECRET = process.env.CONNECTIONS_KEY || "";
const KEY = SECRET ? crypto.createHash("sha256").update(SECRET).digest() : null;

export const encryptionEnabled = Boolean(KEY);

// Returns "base64(iv):base64(tag):base64(ciphertext)".
export function encrypt(obj) {
  if (!KEY) throw new Error("CONNECTIONS_KEY not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const pt = Buffer.from(JSON.stringify(obj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(enc) {
  if (!KEY) throw new Error("CONNECTIONS_KEY not configured");
  const [ivb, tagb, ctb] = String(enc).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivb, "base64"));
  decipher.setAuthTag(Buffer.from(tagb, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctb, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}
