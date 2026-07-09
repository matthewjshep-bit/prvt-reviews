// server.js — public HTTP endpoint GHL fetches at send time.
//   GET /card?name=Jessica&bg=https://...&brand=PRVT%20MKT
// Returns a personalized image (JPEG by default; &format=png for PNG).

import express from "express";
import { renderCard } from "./render.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Tiny bounded in-memory cache so repeated names/bg don't re-render.
const cache = new Map();
const CACHE_MAX = 300;
function cacheGet(k) {
  const v = cache.get(k);
  if (v) {
    cache.delete(k);
    cache.set(k, v); // LRU bump
  }
  return v;
}
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

app.get("/", (_req, res) => res.type("text/plain").send("ok"));

app.get("/card", async (req, res) => {
  const { name, bg, brand, w, h, format, excite, demo, fit, bgColor, headline, accent } =
    req.query;
  const demoOn = demo === "1" || demo === "true";
  const key = JSON.stringify({
    name, bg, brand, w, h, format, excite, demo: demoOn, fit, bgColor, headline, accent,
  });

  try {
    let hit = cacheGet(key);
    if (!hit) {
      hit = await renderCard({
        name,
        bg,
        brand,
        w,
        h,
        format,
        excite: excite !== "0" && excite !== "false",
        demo: demoOn,
        fit,
        bgColor,
        headline,
        accent,
      });
      cacheSet(key, hit);
    }
    res.set("Content-Type", hit.contentType);
    // Cache for a day at the edge / on the carrier side.
    res.set("Cache-Control", "public, max-age=86400");
    res.send(hit.buffer);
  } catch (err) {
    // Never 500 into a workflow — fall back to a plain branded card so the
    // MMS still sends something rather than breaking the whole message.
    console.error("card error:", err?.message || err);
    try {
      const fallback = await renderCard({ name, brand, w, h, format });
      res.set("Content-Type", fallback.contentType);
      res.set("Cache-Control", "no-store");
      res.send(fallback.buffer);
    } catch {
      res.status(400).type("text/plain").send("could not render card");
    }
  }
});

app.listen(PORT, () => console.log(`card service on :${PORT}`));
