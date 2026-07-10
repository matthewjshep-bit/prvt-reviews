// connections.js — decrypt stored connection secrets into provider material.
// Used ONLY on the render/test path; secrets never leave the broker except as
// request headers cardgen sends to the target service.

import { store } from "./store.js";
import { decrypt } from "./crypto.js";

// → { type, headers?/token?/webhookUrl } or undefined.
export async function resolveConnectionById(connectionId, locationId) {
  if (!connectionId) return undefined;
  const row = await store.getConnection(connectionId);
  if (!row || row.locationId !== locationId) return undefined;
  try {
    const secret = decrypt(row.secretEnc);
    return { type: row.type, ...secret };
  } catch {
    return undefined;
  }
}

// Build { [connectionId]: material } for every data source in a template.
export async function resolveConnectionsFor(template, locationId) {
  const out = {};
  for (const ds of template.dataSources || []) {
    if (ds.connectionId && !out[ds.connectionId]) {
      const m = await resolveConnectionById(ds.connectionId, locationId);
      if (m) out[ds.connectionId] = m;
    }
  }
  return out;
}
