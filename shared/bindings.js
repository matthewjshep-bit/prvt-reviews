// bindings.js — {{scope.path}} expression resolution, shared by cardgen (render)
// and messaging-app (client-side preview) so both interpret templates the same.
//
// A binding is `{{ dotted.path }}` resolved against a single root context:
//   { contact: { first_name, …, custom: { <fieldKey>: … } },
//     loc:     { business_name, owner_first_name, … },
//     data:    { <sourceId>: { <key>: … } },
//     inputs:  { <key>: … } }        // only when resolving provider URL/body templates
//
// Scopes in the UI map straight onto this: contact.*, contact.custom.*,
// data.<id>.*, loc.*  (see § binding expression syntax).

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

// Safe dotted-path lookup. Returns undefined for any missing segment.
function getPath(root, path) {
  let cur = root;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

// Collapse punctuation/whitespace left orphaned when a binding resolves empty,
// e.g. "Hey , about ." -> "Hey, about." and "  " -> "".  Intentionally gentle:
// it fixes the common "Hey {{name}}," case without mangling deliberate text.
function tidy(s) {
  return s
    .replace(/[ \t]+([,.;:!?])/g, "$1") // space before punctuation
    .replace(/([([{])\s+/g, "$1") // space after opening bracket
    .replace(/\s+([)\]}])/g, "$1") // space before closing bracket
    .replace(/([,;:])\s*(?=[,.;:!?])/g, "") // doubled punctuation
    .replace(/[ \t]{2,}/g, " ") // collapse runs of spaces
    .replace(/^[\s,;:.!?-]+/, "") // leading orphan punctuation
    .replace(/[ \t]+$/gm, "")
    .trim();
}

// Resolve every {{token}} in `str` against `context`.
//   opts.encode(value) — optional transform applied to each substituted value
//                        (used to URL-encode values in provider URL templates).
//   opts.keepMissing   — when true, leave the raw {{token}} in place instead of
//                        blanking it (used by the editor to show unresolved tags).
// Returns { value, missing: string[] }.
export function resolveBindings(str, context, opts = {}) {
  const missing = [];
  if (typeof str !== "string" || !str) return { value: str || "", missing };
  const { encode, keepMissing } = opts;

  const out = str.replace(TOKEN, (whole, path) => {
    const v = getPath(context, path);
    if (v == null || v === "") {
      missing.push(path);
      return keepMissing ? whole : "";
    }
    const s = String(v);
    return encode ? encode(s) : s;
  });

  return { value: keepMissing ? out : tidy(out), missing };
}

// Convenience: just the resolved string.
export function resolveString(str, context, opts) {
  return resolveBindings(str, context, opts).value;
}

// List the distinct binding paths referenced anywhere in a string.
export function extractBindings(str) {
  if (typeof str !== "string") return [];
  const out = new Set();
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(str))) out.add(m[1]);
  return [...out];
}

// Every binding path referenced by a whole template (all layer text-ish fields
// plus data-source inputs). Used for render-log missing-binding accounting and
// for the "referenced fields" hints in the editor.
export function extractTemplateBindings(template) {
  const out = new Set();
  const add = (s) => extractBindings(s).forEach((b) => out.add(b));
  for (const l of template.layers || []) {
    if (typeof l.content === "string") add(l.content);
    if (typeof l.text === "string") add(l.text);
  }
  for (const ds of template.dataSources || []) {
    for (const v of Object.values(ds.inputs || {})) add(v);
    for (const v of Object.values(ds.options || {})) if (typeof v === "string") add(v);
  }
  return [...out];
}

// Turn a flat { "contact.first_name": "Jessica", "data.parcel.lot_sqft": "7200" }
// map (how the editor stores sampleData) into the nested context the resolver
// reads: { contact: { first_name, custom: {…} }, loc: {…}, data: { parcel: {…} } }.
export function flatToContext(flat) {
  const root = {};
  for (const [path, value] of Object.entries(flat || {})) {
    const segs = String(path).split(".");
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (cur[s] == null || typeof cur[s] !== "object") cur[s] = {};
      cur = cur[s];
    }
    cur[segs[segs.length - 1]] = value;
  }
  return root;
}

export { getPath, tidy };
