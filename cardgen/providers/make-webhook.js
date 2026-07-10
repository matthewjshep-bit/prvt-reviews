// make-webhook — post sample/contact data to a Make.com (or any) webhook and
// flatten the returned JSON object into data.<id>.* (kind: data). This plugs the
// existing Make estate (e.g. King County APN lookup scenarios) into cards with
// zero cardgen changes. It's a discoverable preset of http-json: fixed POST +
// identity mapping. The webhook URL is the secret — store it in a connection
// (type: webhook) so it's encrypted and hidden, or paste it into the option.

import { z } from "zod";
import { safeFetch } from "../net.js";
import { resolveBindings } from "../../shared/bindings.js";
import { jsonEscape } from "./_connection.js";

const optionsSchema = z
  .object({
    webhookUrl: z.string().default("").describe("Webhook URL (or attach a connection of type webhook)"),
    payload: z.string().default("{}").describe("JSON payload template — bindings allowed"),
  })
  .strip();

export default {
  id: "make-webhook",
  name: "Make.com webhook",
  kind: "data",
  auth: "none",
  description: "POST data to a Make/Zapier webhook and use the returned JSON fields (data.<id>.*).",
  inputs: [],
  optionsSchema,
  cacheTtlSeconds: 300,

  async resolve({ options, connection, context }) {
    const url = connection?.webhookUrl || options.webhookUrl;
    if (!url) throw Object.assign(new Error("webhook_url_missing"), { code: "no_url" });
    const body = resolveBindings(options.payload || "{}", context, { encode: jsonEscape }).value;

    const { buffer } = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      maxBytes: 1_000_000,
    });

    let json;
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch {
      // Make often returns a bare string like "Accepted"; expose it as `result`.
      return { data: { result: buffer.toString("utf8").slice(0, 500) } };
    }

    const data = {};
    if (json && typeof json === "object" && !Array.isArray(json)) {
      for (const [k, v] of Object.entries(json)) {
        data[k] = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      }
    } else {
      data.result = typeof json === "object" ? JSON.stringify(json) : String(json);
    }
    return { data };
  },
};
