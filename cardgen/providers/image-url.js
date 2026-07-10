// image-url — the universal image adapter (kind: image). Point it at any
// endpoint that returns an image (chart APIs, QR services, screenshotters, the
// existing ADU feasibility-card generator) and it becomes a layer bitmap.
//
// The url template accepts bindings. Values are NOT URL-encoded here because
// the common pattern is a whole URL held in a field (e.g. a pre-built card
// URL); the SSRF guard + content-type check are the safety controls. To pass a
// dynamic query param, template it explicitly and pre-encode upstream.

import { z } from "zod";
import { safeFetch } from "../net.js";
import { resolveBindings } from "../../shared/bindings.js";
import { headersFrom } from "./_connection.js";

const optionsSchema = z
  .object({
    url: z.string().min(1).describe("Image URL template — bindings allowed, e.g. {{contact.custom.card_url}}"),
  })
  .strip();

export default {
  id: "image-url",
  name: "Image URL",
  kind: "image",
  auth: "none",
  description: "Fetch an image from any external endpoint and use it as a layer.",
  inputs: [],
  optionsSchema,
  cacheTtlSeconds: 3600,

  async resolve({ options, connection, context }) {
    const url = resolveBindings(options.url, context).value;
    if (!url) throw Object.assign(new Error("empty_url"), { code: "empty_url" });
    const { buffer } = await safeFetch(url, {
      headers: headersFrom(connection),
      contentTypePrefix: "image/",
      maxBytes: 8_000_000,
    });
    return { imageBuffer: buffer, data: { source_url: url } };
  },
};
