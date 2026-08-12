---
name: Offer Generator
description: Swiss-minimal operator console for high-volume cash offers, embedded in GoHighLevel
colors:
  action-blue: "#2563EB"
  action-blue-hover: "#1D4ED8"
  deal-green: "#059669"
  deal-green-text: "#047857"
  paper: "#F8FAFC"
  surface: "#FFFFFF"
  ink: "#0F172A"
  ink-soft: "#334155"
  ink-muted: "#64748B"
  ink-faint: "#94A3B8"
  hairline: "#E2E8F0"
  hairline-soft: "#F1F5F9"
  warn-bg: "#FFFBEB"
  warn-text: "#92400E"
  danger: "#DC2626"
typography:
  headline:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.025em"
  meta:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
  micro:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    letterSpacing: "0.02em"
  doc-display:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
  doc-title:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1.3125rem"
    fontWeight: 700
    letterSpacing: "-0.01em"
    lineHeight: 1.25
  doc-figure:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
  doc-heading:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    letterSpacing: "-0.005em"
  doc-body:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.action-blue-hover}"
  nav-pill-active:
    backgroundColor: "{colors.action-blue}"
    textColor: "#FFFFFF"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
---

# Design System: Offer Generator

## Overview

**Creative North Star: "The Deal Desk"**

A flat, Swiss-minimal operator console: white working surfaces on a cool paper background, hairline borders instead of shadows, one decisive blue for actions and one green reserved for money that is going the operator's way. The interface is dense (density 8/10) because the user works it dozens of times a day inside a GoHighLevel iframe — scanability and speed outrank expression. Brand lives in precision: aligned columns, tabular money figures, consistent pills, and a single confident typeface (Plus Jakarta Sans) doing every job.

**Key Characteristics:**
- Flat surfaces, hairline borders, near-zero shadow use (modals only)
- Dense text scale: 18px headline, 14px body, 12px labels, uppercase-tracked table headers,
  plus 11px `meta` (row subtext, chips, timestamps) and 10px `micro` (status pills) — the
  console leans on those last two heavily, so they are part of the ramp, not exceptions
- Blue = act, green = money in, amber = attention, red = risk
- Table-heavy views run full-bleed inside the iframe; forms stay capped and centered

## Two surfaces

The system covers two audiences, and they are not the same design problem.

**Console** (`messaging-app/`) — the operator app inside the GHL iframe. Everything
above describes it: dense, desktop-first, worked dozens of times a day.

**Investor document** (`ghl-broker/dataroom.js`) — the public pages served at
`/d/<token>`: a deal package and the all-deals portfolio. Same palette and the
same flat/hairline construction, but it uses the `doc-*` type steps
(`doc-display` 24, `doc-title` 21, `doc-figure` 20, `doc-heading` 15, `doc-body`
13) because it is read once, on a phone, by someone outside the business who is
deciding whether to spend money. Density is the wrong goal there; legibility and
confidence are. Radii stay on the shared `md`/`lg`/`pill` steps, and it
introduces no colors of its own.

The two scales share only their small end — `label`, `meta`, `micro` — for
eyebrows, table headers and fine print. Reach for the console's 14px `body` on an
investor page and that page is probably trying to be a table when it should be a
document.

Two things about the investor document are worth knowing before designing for it,
because both are enforced by its Content-Security-Policy (`default-src 'none'`)
rather than by convention:

- **It renders in system fonts, not Plus Jakarta Sans.** There is no `font-src`,
  so a webfont cannot load; the stack falls through to SF Pro on iPhones and
  Roboto on Android. Weight and size contrast, not typeface, are what make these
  pages feel designed. Embedding a subset as a `data:` URI is possible but has
  been judged not worth the first-paint cost on cell service.
- **It runs no JavaScript at all** — there is no `script-src`. Every interaction
  must be pure CSS. Hence the photo gallery is a `scroll-snap` strip with photos
  opening full-size in a new tab, rather than a carousel or lightbox.

**Photography.** The investor document is the only surface with photographs. A
deal page leads with a 3:2 hero (the operator's first photo) carrying the address
and price over a scrim; remaining photos sit in a horizontal strip. Portfolio
cards lead with the same photo as a 3:2 thumbnail with the price badged over its
lower-left. Deals without photos get a flat `#F1F5F9` placeholder reading "Photos
coming soon" — never a broken image, and never a stretched one: every photo is
`object-fit: cover` at a fixed aspect ratio so mixed portrait/landscape uploads
still tile evenly.

## Colors

A restrained slate-neutral system with two working accents.

### Primary
- **Action Blue** (#2563EB): the one interactive color — primary buttons, active nav pill, focus rings, selection. Hover deepens to #1D4ED8.

### Secondary
- **Deal Green** (#059669): reserved for money moving toward the operator — assignment fees, closed-won states, success confirmations. Text-on-white uses the darker #047857.

### Neutral
- **Paper** (#F8FAFC): page background behind everything.
- **Surface** (#FFFFFF): cards, tables, modals, header.
- **Ink** (#0F172A): headings and primary data.
- **Ink Soft / Muted / Faint** (#334155 / #64748B / #94A3B8): body → secondary → disabled/placeholder text, in that order.
- **Hairline** (#E2E8F0) and **Hairline Soft** (#F1F5F9): container borders and row dividers respectively.
- **Amber family** (bg #FFFBEB, text #92400E): warnings and "waiting on someone" states. **Red** (#DC2626): destructive and overdue.

### Named Rules
**The Two-Accent Rule.** Blue acts, green counts money. No other saturated color appears except amber/red status semantics. Never introduce purple, teal, or gradients — with one carve-out: the **photo scrim** on the investor document (a top-to-bottom ink fade behind the address overlaid on a hero photograph). That is a legibility device, not decoration — white type has to sit on an arbitrary photograph — and it is the only gradient in the system. It never appears on the console, and it never carries color, only `#0F172A` at varying alpha.
**The Gray-Ladder Rule.** Text de-emphasis walks the slate ladder (900 → 700 → 500 → 400) and never drops below slate-500 (#64748B) for text a user must read.

## Typography

**Display/Body Font:** Plus Jakarta Sans (system-ui fallback)

**Character:** Friendly-professional SaaS grotesque; slightly rounded terminals keep density from feeling severe.

### Hierarchy
- **Headline** (700, 18px, tight tracking): view titles, modal titles.
- **Title** (600, 14px): card headings, table emphasis cells.
- **Body** (400, 14px, 1.5): default for all table and form content.
- **Label** (600, 12px, +0.025em, often uppercase): table headers, stat-card captions, pills.
- **Money** (600–700, tabular where possible): right-aligned in tables.

### Named Rules
**The 12px Floor Rule.** No functional text below 12px; the legacy `text-[11px]` chips are the floor exception and must stay bold + high-contrast.

## Layout

Sticky white header (backdrop-blur, hairline bottom border) with pill navigation. Content area: table-heavy views (History, Deals, Dashboard, Agents) are full-bleed with `px-4 sm:px-6 lg:px-8` gutters to use the GHL iframe's width; the New Offer form is capped at `max-w-7xl` and centered; Settings self-caps at `max-w-2xl`. Header and content share the same width treatment so edges always align. Spacing rhythm is a 4px base (4/8/12/16/24); table cells are `px-4 py-2.5`. Tables live inside `rounded-xl` hairline containers with `overflow-x-auto` as the narrow-viewport fallback.

## Elevation & Depth

Flat by default. Depth is conveyed by background steps (paper → surface) and hairlines, not shadows. Shadows appear only on overlays: modals (`shadow-xl`) over a `bg-black/40` scrim. Never add glow, colored shadows, or hover-lift transforms to in-page elements.

## Shapes

Soft-rectangle language: `rounded-lg` (8px) for buttons and inputs, `rounded-xl` (12px) for cards and table containers, `rounded-2xl` (16px) for modals, full pills for nav and status chips. Borders are 1px hairlines; dashed hairline borders mark empty states.

## Components

### Buttons
- **Shape:** rounded-lg (8px), padding ~8px 16px, font-semibold 14px.
- **Primary:** Action Blue bg, white text; hover bg-blue-700. Green (#059669) variant only for money-positive confirmations.
- **Secondary/Ghost:** white or transparent bg, hairline border, slate-700 text; hover bg-slate-50.
- **Focus:** visible ring in Action Blue. All clickables get `cursor-pointer`; transitions 150–250ms.

### Pills / Chips
- **Nav pill:** full radius, 14px medium; active = solid blue + white text, inactive = slate-600 with hover bg-slate-100.
- **Status pills:** tinted background + dark text of the same hue (e.g. amber-100/amber-800 "Under contract"); 11–12px semibold.

### Cards / Stat tiles
- **Style:** white surface, hairline border, rounded-xl, no shadow; uppercase 12px slate-500 caption over a large bold value.

### Tables
- **Header row:** 12px uppercase tracked slate-500, hairline bottom border.
- **Rows:** hairline-soft dividers, `hover:bg-slate-50`, `cursor-pointer` when clickable; money columns right-aligned and semibold; addresses truncate with a `title` tooltip.

### Inputs
- **Style:** white bg, hairline border, rounded-lg, 14px; focus = blue border + 3px blue ring at 12% opacity.

### Modals
- **Style:** rounded-2xl white panel, shadow-xl, over black/40 scrim; capped `max-w-3xl`.

## Do's and Don'ts

### Do:
- **Do** right-align and embolden every money figure; use Deal Green only when the money flows to the operator.
- **Do** keep table-heavy views full-bleed and forms capped; header gutters must match content gutters.
- **Do** use hairline borders for structure and background steps for depth.
- **Do** keep hover/focus transitions in the 150–250ms range and respect `prefers-reduced-motion`.

### Don't:
- **Don't** add shadows to in-page cards, gradients anywhere, or any third accent hue.
- **Don't** use text lighter than slate-500 for content, or functional text under 12px (11px chip floor excepted).
- **Don't** use emojis as icons — Lucide SVGs only, one consistent set.
- **Don't** use scale/translate hovers that shift layout; hover feedback is background-tint only.
