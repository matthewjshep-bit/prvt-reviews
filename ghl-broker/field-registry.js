// field-registry.js — the single source of truth for every contact custom
// field the app owns, across all three features that create them (offer
// writes, outreach imports, AI enrichment). The Fields Manager UI reads the
// aggregated registry to visualize what exists in GHL vs what the app expects.

import { SHARED_ENRICH_FIELDS, AGENT_ENRICH_FIELDS, INVESTOR_ENRICH_FIELDS } from "./enrich.js";

// Contact custom fields the app writes on every offer (created on demand).
export const OFFER_FIELDS = [
  { key: "last_offer_amount", name: "Last Offer Amount", dataType: "NUMERICAL" },
  { key: "last_offer_date", name: "Last Offer Date", dataType: "TEXT" },
  { key: "last_offer_doc_url", name: "Last Offer Document URL", dataType: "TEXT" },
  { key: "last_offer_image_url", name: "Last Offer Image URL", dataType: "TEXT" },
  { key: "zillow_link", name: "Zillow Link", dataType: "TEXT" },
  { key: "offer_app_link", name: "Offer App Link", dataType: "TEXT" },
];

// Contact custom fields written on outreach import (created on demand).
export const OUTREACH_FIELDS = [
  // Pre-existing field in this GHL location (contact.short_hand_property_address)
  // — matched by key, so the existing definition is reused, not duplicated.
  { key: "short_hand_property_address", name: "short hand property address", dataType: "TEXT" },
  { key: "hook_address", name: "Hook Address", dataType: "TEXT" },
  { key: "hook_price", name: "Hook Price", dataType: "NUMERICAL" },
  { key: "hook_dom", name: "Hook Days on Market", dataType: "NUMERICAL" },
  { key: "hook_url", name: "Hook URL", dataType: "TEXT" },
  { key: "brokerage", name: "Brokerage", dataType: "TEXT" },
];

// Every app-owned field, tagged with the feature that owns it. Row shape:
// { key, name, dataType, values?, multi?, hint?, serverSet?, source }.
export const APP_FIELD_REGISTRY = [
  ...OFFER_FIELDS.map((f) => ({ ...f, source: "offers" })),
  ...OUTREACH_FIELDS.map((f) => ({ ...f, source: "outreach" })),
  ...SHARED_ENRICH_FIELDS.map((f) => ({ ...f, source: "enrich-shared" })),
  ...AGENT_ENRICH_FIELDS.map((f) => ({ ...f, source: "enrich-agent" })),
  ...INVESTOR_ENRICH_FIELDS.map((f) => ({ ...f, source: "enrich-investor" })),
];

export const registryByKey = new Map(APP_FIELD_REGISTRY.map((f) => [f.key, f]));
