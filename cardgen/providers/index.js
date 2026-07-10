// providers/index.js — the provider registry (§3). Adding a new external
// service means registering ONE module here; the render pipeline, schema, and
// editor shell never change. Each module: { id, name, kind, description,
// inputs, optionsSchema (zod), auth, cacheTtlSeconds, resolve(ctx) }.

// Provider modules are loaded dynamically so new ones drop in as a single file
// with no edit here. Phase 5: http-json, image-url. Phase 7: make-webhook,
// mapbox-pin, mapbox-parcel. A module absent on disk is simply skipped.
const MODULE_PATHS = [
  "./http-json.js",
  "./image-url.js",
  "./make-webhook.js",
  "./mapbox-pin.js",
  "./mapbox-parcel.js",
];

const REGISTRY = new Map();
function register(p) {
  if (p && p.id) REGISTRY.set(p.id, p);
}
for (const p of MODULE_PATHS) {
  try {
    const mod = await import(p);
    register(mod.default);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") console.error(`provider ${p} failed to load:`, err.message);
  }
}

export function getProvider(id) {
  return REGISTRY.get(id) || null;
}

export function listProviders() {
  return [...REGISTRY.values()];
}

// Serialize a zod options schema into a JSON form spec for the editor (we do
// NOT ship zod to the client). Best-effort over the field types providers use.
export function zodToFormSpec(schema) {
  const fields = [];
  const shape = schema?._def?.shape ? schema._def.shape() : schema?.shape;
  if (!shape) return fields;

  for (const [key, def0] of Object.entries(shape)) {
    let def = def0;
    let required = true;
    let defaultValue;
    let description = def0?._def?.description;

    // Unwrap ZodOptional / ZodDefault / ZodNullable.
    for (let i = 0; i < 6; i++) {
      const t = def?._def?.typeName;
      if (t === "ZodOptional" || t === "ZodNullable") {
        required = false;
        def = def._def.innerType;
      } else if (t === "ZodDefault") {
        defaultValue = def._def.defaultValue();
        required = false;
        def = def._def.innerType;
      } else break;
      description = description || def?._def?.description;
    }

    const t = def?._def?.typeName;
    let field = { key, label: labelize(key), required, default: defaultValue };
    if (description === "color") field.type = "color";
    else if (t === "ZodEnum") {
      field.type = "select";
      field.options = def._def.values;
    } else if (t === "ZodBoolean") field.type = "toggle";
    else if (t === "ZodNumber") field.type = "number";
    else if (t === "ZodArray") {
      field.type = "list";
      field.item = arrayItemSpec(def._def.type);
    } else field.type = "text";

    if (description && description !== "color") field.hint = description;
    fields.push(field);
  }
  return fields;
}

function arrayItemSpec(itemDef) {
  // Only objects-of-strings are used (e.g. http-json mappings [{key, jsonPath}]).
  const shape = itemDef?._def?.shape ? itemDef._def.shape() : itemDef?.shape;
  if (!shape) return { type: "text" };
  return {
    type: "object",
    fields: Object.keys(shape).map((k) => ({ key: k, label: labelize(k), type: "text" })),
  };
}

function labelize(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ").replace(/^\w/, (c) => c.toUpperCase()).trim();
}
