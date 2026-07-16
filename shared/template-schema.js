// template-schema.js — the single source of truth for the Dynamic Card Studio
// template document. Imported by:
//   • messaging-app (editor: validate before save, build starters)
//   • ghl-broker    (CRUD: validate on create/update)
//   • cardgen       (render: validate before compositing)
//
// Authored as ESM + zod (not .ts) because this repo has no TypeScript build
// step and all three consumers are plain ES modules — Vite and Node both import
// this file directly. `shared/` ships its own node_modules/zod so the bare
// `zod` specifier resolves no matter which package imports this path.
//
// Coordinates are PERCENT (0–100) of canvas width/height, never pixels, so a
// template survives canvas-size changes (§ architecture rule 6).

import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

// Percent coordinate/size. Positions may sit slightly off-canvas while
// dragging, so allow a little overshoot rather than hard-clamping here.
const pct = z.number().min(-50).max(150);
const sizePct = z.number().min(0).max(200);

// #rgb / #rrggbb, or an rgba()/rgb() string (used by scrim shapes). Anything
// else is rejected at validation time; the renderer additionally hardens.
const color = z
  .string()
  .trim()
  .regex(
    /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/,
    "must be a hex or rgb(a) color"
  );

const fontFamily = z.enum(["Inter", "Source Serif", "Archivo Black"]);
const fontWeight = z.enum(["regular", "bold"]);
const align = z.enum(["left", "center", "right"]);
const fit = z.enum(["cover", "contain"]);

const textShadow = z
  .object({
    color: color,
    blur: z.number().min(0).max(50).default(0),
    dx: z.number().min(-50).max(50).default(0),
    dy: z.number().min(-50).max(50).default(0),
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Layer common fields
 * ------------------------------------------------------------------ */

const layerBase = {
  id: z.string().min(1),
  x: pct,
  y: pct,
  width: sizePct,
  height: sizePct,
  rotation: z.number().min(-360).max(360).default(0).optional(),
  opacity: z.number().min(0).max(1).default(1).optional(),
  locked: z.boolean().default(false).optional(),
  visible: z.boolean().default(true).optional(),
};

/* ------------------------------------------------------------------ *
 * Layer variants (discriminated union on `type`)
 * ------------------------------------------------------------------ */

const imageLayer = z
  .object({
    ...layerBase,
    type: z.literal("image"),
    src: z.string().url().or(z.literal("")).default(""), // R2 URL of uploaded asset
    fit: fit.default("cover"),
    cornerRadius: z.number().min(0).max(500).default(0).optional(),
  })
  .strict();

const dynamicImageLayer = z
  .object({
    ...layerBase,
    type: z.literal("dynamic-image"),
    sourceId: z.string().min(1), // references dataSources[].id (kind image|both)
    fit: fit.default("cover"),
    cornerRadius: z.number().min(0).max(500).default(0).optional(),
    // Editor-only cached preview of the bound source's last test image. Ignored
    // by the renderer (it re-runs the provider); persisted so the canvas/phone
    // preview show the image on reload.
    thumbnailUrl: z.string().optional(),
  })
  .strict();

const textLayer = z
  .object({
    ...layerBase,
    type: z.literal("text"),
    content: z.string().default(""), // may contain {{scope.path}} bindings
    fontFamily: fontFamily.default("Inter"),
    fontWeight: fontWeight.default("regular"),
    fontSize: z.number().min(4).max(400).default(48), // px at canvas scale
    color: color.default("#ffffff"),
    align: align.default("left"),
    lineHeight: z.number().min(0.5).max(3).default(1.2),
    autoFit: z.boolean().default(false),
    maxLines: z.number().int().min(1).max(40).default(3).optional(), // 40 = one-pager body copy
    textShadow: textShadow.optional(),
  })
  .strict();

const nameBoxLayer = z
  .object({
    ...layerBase,
    type: z.literal("name-box"),
    content: z.string().default("{{contact.first_name}}!"),
    bgColor: color.default("#ffffff"),
    textColor: color.default("#0b0b0c"),
    fontFamily: fontFamily.default("Inter"),
    fontSize: z.number().min(4).max(400).default(92),
    paddingX: z.number().min(0).max(200).default(54),
    paddingY: z.number().min(0).max(200).default(0),
    cornerRadius: z.number().min(0).max(9999).default(999), // >= half-height == fully rounded pill
  })
  .strict();

const shapeLayer = z
  .object({
    ...layerBase,
    type: z.literal("shape"),
    shape: z.enum(["rect", "ellipse", "line"]),
    fill: color.default("#000000"),
    stroke: color.optional(),
    strokeWidth: z.number().min(0).max(100).default(0).optional(),
    cornerRadius: z.number().min(0).max(500).default(0).optional(),
  })
  .strict();

const badgeLayer = z
  .object({
    ...layerBase,
    type: z.literal("badge"),
    icon: z.enum(["star", "phone", "pin", "check", "dollar"]).optional(),
    text: z.string().default(""),
    bgColor: color.default("#000000"),
    textColor: color.default("#ffffff"),
    fontFamily: fontFamily.default("Inter"),
    fontSize: z.number().min(4).max(200).default(40),
    cornerRadius: z.number().min(0).max(9999).default(999).optional(),
  })
  .strict();

export const LayerSchema = z.discriminatedUnion("type", [
  imageLayer,
  dynamicImageLayer,
  textLayer,
  nameBoxLayer,
  shapeLayer,
  badgeLayer,
]);

export const LAYER_TYPES = ["image", "dynamic-image", "text", "name-box", "shape", "badge"];

/* ------------------------------------------------------------------ *
 * Data sources (template-level provider attachments — see §3)
 * ------------------------------------------------------------------ */

export const DataSourceSchema = z
  .object({
    // short slug used in bindings: data.<id>.* — letters/digits/underscore.
    id: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/i, "must start with a letter; letters/digits/underscore only"),
    provider: z.string().min(1), // registry id, e.g. 'mapbox-parcel', 'http-json'
    inputs: z.record(z.string(), z.string()).default({}), // key -> binding expression
    options: z.record(z.string(), z.unknown()).default({}), // validated per-provider
    connectionId: z.string().optional(), // for auth === 'connection'
    // Editor convenience cache from the last Test run (§ data sources panel).
    discoveredKeys: z.array(z.string()).default([]).optional(),
    thumbnailUrl: z.string().optional(),
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Canvas + Template
 * ------------------------------------------------------------------ */

export const CANVAS_PRESETS = {
  square: { width: 1080, height: 1080, label: "Square (MMS)" },
  landscape: { width: 1200, height: 628, label: "Landscape / social" },
  story: { width: 1080, height: 1920, label: "Story" },
  letter: { width: 1224, height: 1584, label: "One-pager (letter)" },
};

const canvas = z
  .object({
    width: z.number().int().min(200).max(4000),
    height: z.number().int().min(200).max(4000),
  })
  .strict();

// The full document as persisted. id/version/timestamps are server-assigned;
// they're optional here so the editor can POST a draft without them.
export const TemplateSchema = z
  .object({
    id: z.string().uuid().optional(),
    locationId: z.string().min(1),
    name: z.string().min(1).max(120).default("Untitled template"),
    version: z.number().int().min(1).default(1).optional(),
    canvas: canvas.default({ width: 1080, height: 1080 }),
    background: z.object({ color: color }).strict().default({ color: "#0b0b0c" }),
    dataSources: z.array(DataSourceSchema).default([]),
    layers: z.array(LayerSchema).default([]),
    sampleData: z.record(z.string(), z.string()).default({}),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

// Body accepted by POST/PUT — everything server-managed is stripped/ignored.
export const TemplateInputSchema = TemplateSchema.omit({
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

// Validate + apply defaults. Throws a zod error on failure.
export function parseTemplate(doc) {
  return TemplateSchema.parse(doc);
}

// Non-throwing variant → { success, data | error }.
export function safeParseTemplate(doc) {
  return TemplateSchema.safeParse(doc);
}

export default TemplateSchema;
