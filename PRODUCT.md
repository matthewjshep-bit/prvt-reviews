# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Real-estate wholesalers running "The Agent Method" — sending high-volume lowball cash offers on listed properties and building listing-agent relationships. Primary user is the operator (currently Matt) working inside GoHighLevel (GHL): the app's pages are embedded as GHL custom-menu iframes and every session arrives with a `?location_id=`. Secondary audience: the listing agents who receive the generated offer documents. (Inferred from repo + prior sessions; not re-confirmed this session.)

## Product Purpose

Generate professional cash-offer packages (offer PDF, scope of work, comps) in seconds, log every offer per agent contact, and track accepted offers through disposition (Deals board), plus source fixer-friendly agents (Agent Outreach) and monitor KPIs (Dashboard). Success = volume with credibility: ~10 offers/day, ~120 offers per contract, ~$15K assignment fee per deal.

## Operating Context

- Runs inside GHL iframes (wide desktop frames, ~1300–1600px); also opened as standalone pages (`/deals`, `/agents`, `/dashboard`) from GHL menu links.
- One Vite/React SPA (`messaging-app/`) serves all four products; Netlify deploy; backend is the `ghl-broker` service.
- Contacts, conversations, and custom fields live in GHL; the app deep-links back to GHL contact records.

## Capabilities and Constraints

- Views: New Offer (form + 3-tier offer calc), History (offers grouped by agent), Deals (pipeline from under-contract to closed, investors, fees), Settings, Dashboard, Agent Outreach.
- Offer documents are generated server-side and attached to GHL contact records.
- Desktop-first: users operate it inside GHL on desktop; mobile is a fallback, not a primary scene.
- Data volumes are modest (hundreds of offers, tens of deals) — tables, not virtualized grids.

## Product Principles

- Speed over ceremony: the operator does this dozens of times a day; fewer clicks beats more explanation.
- Scanability: History and Deals are worked as lists — dense rows, clear money figures, obvious status.
- Trust artifacts: anything an agent sees (offer PDFs) must look professional; internal UI can be utilitarian.
- One system: all four surfaces share one visual language (see DESIGN.md).
