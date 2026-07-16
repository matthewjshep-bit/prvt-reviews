// website-shot — screenshot of a website (kind: image), e.g. the contact's own
// site pulled from {{contact.website}} or a custom field. Uses WordPress's
// public mShots service (no API key): the first request kicks off generation
// and serves a GIF placeholder, so we poll until the real JPEG is ready.
// The target URL is only ever fetched BY mShots — cardgen never touches the
// user-supplied site directly (no SSRF surface beyond s0.wp.com).

import { z } from "zod";
import { safeFetch } from "../net.js";

const MSHOTS = "https://s0.wp.com/mshots/v1";

const optionsSchema = z
  .object({
    width: z.number().min(320).max(1600).default(1200).describe("Screenshot width in px"),
  })
  .strip();

const isGif = (buf) => buf && buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8";

export default {
  id: "website-shot",
  name: "Website screenshot",
  kind: "image",
  auth: "none",
  description: "A screenshot of any website — e.g. the contact's own site ({{contact.website}}).",
  inputs: [{ key: "url", label: "Website URL", required: true }],
  optionsSchema,
  cacheTtlSeconds: 7 * 24 * 3600, // sites change slowly; re-shoot weekly

  async resolve({ inputs, options, targetPx }) {
    let url = String(inputs.url || "").trim();
    if (!url) throw Object.assign(new Error("empty_url"), { code: "empty_url" });
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    const w = Math.min(1600, Math.max(320, Math.round(options.width || (targetPx?.width ? targetPx.width * 1.5 : 1200))));
    const shotUrl = `${MSHOTS}/${encodeURIComponent(url)}?w=${w}`;

    // mShots serves a GIF placeholder while rendering; real shots are JPEG.
    for (let attempt = 0; attempt < 8; attempt++) {
      const { buffer } = await safeFetch(shotUrl, { contentTypePrefix: "image/", maxBytes: 10_000_000 });
      if (!isGif(buffer) && buffer.length > 4000) {
        return { imageBuffer: buffer, data: { url } };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw Object.assign(new Error("screenshot_not_ready"), { code: "not_ready" });
  },
};
