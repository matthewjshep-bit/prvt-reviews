// http-json — the universal REST adapter (kind: data). Point it at any JSON
// API, map fields with JSONPath, and they become data.<id>.* — zero code.
// URL/body templates accept {{contact.*}} / {{inputs.*}} / {{data.*}} bindings;
// values substituted into the URL are URL-encoded (§4).

import { z } from "zod";
import { JSONPath } from "jsonpath-plus";
import { safeFetch } from "../net.js";
import { resolveBindings } from "../../shared/bindings.js";
import { headersFrom, jsonEscape } from "./_connection.js";

const optionsSchema = z
  .object({
    url: z.string().min(1).describe("URL template — bindings allowed, e.g. https://api.x.com/lookup?q={{inputs.query}}"),
    method: z.enum(["GET", "POST"]).default("GET"),
    bodyTemplate: z.string().default("").describe("JSON body template (POST only), bindings allowed"),
    mappings: z
      .array(z.object({ key: z.string().min(1), jsonPath: z.string().min(1) }))
      .default([])
      .describe("Each JSONPath's first match becomes data.<id>.<key>"),
  })
  .strip();

export default {
  id: "http-json",
  name: "HTTP JSON API",
  kind: "data",
  auth: "none",
  description: "Call any JSON REST API and map response fields into data.<id>.* via JSONPath.",
  inputs: [],
  optionsSchema,
  cacheTtlSeconds: 3600,

  async resolve({ options, connection, context }) {
    const url = resolveBindings(options.url, context, { encode: encodeURIComponent }).value;
    const headers = headersFrom(connection);
    let body;
    if (options.method === "POST") {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      body = options.bodyTemplate ? resolveBindings(options.bodyTemplate, context, { encode: jsonEscape }).value : undefined;
    }

    const { buffer } = await safeFetch(url, { method: options.method, headers, body, maxBytes: 1_000_000 });
    let json;
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw Object.assign(new Error("invalid_json_response"), { code: "invalid_json" });
    }

    const data = {};
    for (const m of options.mappings || []) {
      let res;
      try {
        res = JSONPath({ path: m.jsonPath, json, wrap: false });
      } catch {
        res = undefined;
      }
      if (Array.isArray(res)) res = res[0];
      data[m.key] = res == null ? "" : typeof res === "object" ? JSON.stringify(res) : String(res);
    }
    return { data };
  },
};
