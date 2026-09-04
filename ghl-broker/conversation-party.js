// conversation-party.js — who is texting us: a listing agent, an investor, or
// someone we can't place. Pure.
//
// The answer comes from GHL tags, matched against the patterns the operator
// set on the Conversation AI page — not from enrich.js's inferContactType,
// whose substring rules ("dispo" means investor) call an agent who was tagged
// into a dispo blast ambiguous. Here the operator owns the vocabulary, `*` is
// the only wildcard, and a contact carrying both kinds of tag goes to the
// party the page says wins.

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The tags (lowercased) that match any of the patterns. A pattern without a
// `*` is an exact, case-insensitive tag name.
export function matchTagPatterns(tags = [], patterns = []) {
  const have = (Array.isArray(tags) ? tags : []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const p of patterns || []) {
    const pat = String(p || "").trim().toLowerCase();
    if (!pat) continue;
    const rx = pat.includes("*")
      ? new RegExp(`^${pat.split("*").map(escapeRx).join(".*")}$`)
      : null;
    for (const t of have) {
      if ((rx ? rx.test(t) : t === pat) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * resolveParty({ explicit, tags, routing })
 *
 * Returns { party: "agent" | "investor" | "unknown", source, matched }.
 * An explicit party from the webhook (the GHL workflow already knows who it
 * routed) wins outright; otherwise the tag rules decide; both matching goes
 * to routing.priority; neither is "unknown", which the caller holds or
 * answers generically per routing.unknown.
 */
export function resolveParty({ explicit = "", tags = [], routing = {} } = {}) {
  const asked = String(explicit || "").trim().toLowerCase();
  const matched = {
    agent: matchTagPatterns(tags, routing.agentTags || []),
    investor: matchTagPatterns(tags, routing.investorTags || []),
  };
  if (asked === "agent" || asked === "investor") return { party: asked, source: "explicit", matched };
  const isAgent = matched.agent.length > 0;
  const isInvestor = matched.investor.length > 0;
  if (isAgent && isInvestor) return { party: routing.priority === "investor" ? "investor" : "agent", source: "tags", matched };
  if (isAgent) return { party: "agent", source: "tags", matched };
  if (isInvestor) return { party: "investor", source: "tags", matched };
  return { party: "unknown", source: "none", matched };
}
