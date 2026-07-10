// _connection.js — turn decrypted connection material into request headers.
// The broker decrypts a `connections` row (AES-256-GCM) and passes this shape:
//   { type: 'header', headers: { "X-Api-Key": "…" } }
//   { type: 'bearer', token: "…" }
//   { type: 'webhook', webhookUrl: "https://hook.make.com/…" }

export function headersFrom(connection) {
  if (!connection) return {};
  if (connection.type === "bearer" && connection.token) return { Authorization: `Bearer ${connection.token}` };
  if (connection.type === "header" && connection.headers && typeof connection.headers === "object") {
    const out = {};
    for (const [k, v] of Object.entries(connection.headers)) if (k) out[String(k)] = String(v);
    return out;
  }
  return {};
}

// JSON-string-safe escaping for values substituted into a POST body template.
// JSON.stringify handles every escape (quotes, backslashes, control chars)
// correctly; we drop the surrounding quotes so the value drops into a
// "…{{token}}…" position inside a JSON template string.
export function jsonEscape(v) {
  return JSON.stringify(String(v)).slice(1, -1);
}
