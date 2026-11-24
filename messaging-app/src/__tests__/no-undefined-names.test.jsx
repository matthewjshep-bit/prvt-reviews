// no-undefined-names.test.jsx — every name a screen uses is defined (2026-11-24).
// The 11-23 audit merge left one line of OfferApp.jsx on the old APP_MODE name
// after the shell moved to lanes. The build and every test passed, and the
// live app was a blank page ("ReferenceError: APP_MODE is not defined") from
// 9pm 11-23 until Matt asked why it wasn't working. A bundler never checks an
// undefined name; this does, for every file under src/.
import { test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
const traverse = traverseMod.default || traverseMod;

const BROWSER = ["window", "document", "navigator", "location", "history", "localStorage", "sessionStorage", "fetch", "alert", "confirm", "prompt",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "matchMedia", "screen", "open", "Image", "HTMLElement", "Node", "CustomEvent",
  "ResizeObserver", "IntersectionObserver", "MutationObserver", "DOMParser", "XMLSerializer", "Notification", "WebSocket", "EventSource", "CSS",
  "createImageBitmap", "innerWidth", "innerHeight", "scrollY", "scrollX", "devicePixelRatio", "self", "top", "parent", "FileReader", "Blob", "File", "FormData"];
const KNOWN = new Set([...Object.getOwnPropertyNames(globalThis), ...BROWSER]);

function unbound(code) {
  const out = [];
  traverse(parse(code, { sourceType: "module", plugins: ["jsx"] }), {
    ReferencedIdentifier(p) {
      const n = p.node.name;
      if (p.isJSXIdentifier() && /^[a-z]/.test(n)) return; // <div>, <span>
      if (!p.scope.hasBinding(n) && !KNOWN.has(n)) out.push(`${n} (line ${p.node.loc.start.line})`);
    },
  });
  return out;
}

test("a name a screen uses that nothing defines is caught", () => {
  expect(unbound(`export default function App() { return <div>{APP_MODE === "luxury" && <b />}</div>; }`)).toEqual(["APP_MODE (line 1)"]);
});

test("every name every screen uses is defined", () => {
  const dir = path.resolve(__dirname, "..");
  const found = {};
  for (const f of fs.readdirSync(dir).filter((f) => /\.(jsx|js)$/.test(f))) {
    const u = unbound(fs.readFileSync(path.join(dir, f), "utf8"));
    if (u.length) found[f] = u;
  }
  expect(found).toEqual({});
});
