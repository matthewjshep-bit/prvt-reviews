// ContactLink.jsx — a person's name, anywhere in the console, opens their
// record. The drawer itself lives at the app root (OfferApp.jsx) so every
// host — the offers console and the Overview app — has it; this is the
// context that reaches it and the link that uses it. Without a provider it
// degrades to the plain GHL anchor it replaced, so nothing breaks in a tree
// that never mounted the drawer.

import React, { createContext, useContext } from "react";
import { ExternalLink } from "lucide-react";
import { ghlContactUrl } from "./api.js";

export const ContactDrawerContext = createContext(null);
export const useOpenContact = () => useContext(ContactDrawerContext);

export default function ContactLink({ contactId, name, party = null, className = "", iconOnly = false, title, stopPropagation = false, children }) {
  const ctx = useOpenContact();
  const label = children ?? (name || contactId);
  const stop = (e) => { if (stopPropagation) e.stopPropagation(); };
  if (!contactId) return <span className={className}>{label}</span>;
  if (!ctx) {
    return (
      <a href={ghlContactUrl(contactId)} target="_blank" rel="noreferrer" onClick={stop} title={title || "Open in GoHighLevel"} className={className}>
        {label} <ExternalLink size={11} className="inline shrink-0 text-slate-400" />
      </a>
    );
  }
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
      <button type="button" title={title || "Open their record"}
        onClick={(e) => { stop(e); ctx.open(contactId, { party, name }); }}
        className={iconOnly ? "text-slate-400 hover:text-slate-700" : "min-w-0 truncate text-left underline decoration-slate-300 underline-offset-2 hover:text-blue-700 hover:decoration-blue-400"}>
        {label}
      </button>
      {/* GHL stays one click away — the record is ours, the inbox is theirs. */}
      <a href={ghlContactUrl(contactId)} target="_blank" rel="noreferrer" onClick={stop} title="Open in GoHighLevel"
        className="shrink-0 text-slate-400 hover:text-slate-700">
        <ExternalLink size={11} />
      </a>
    </span>
  );
}
