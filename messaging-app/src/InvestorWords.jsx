// InvestorWords.jsx — "In their words" on an investor's row in Dispositions.
//
// What they told us about how they buy (shared/investor-read.js): the columns
// read from their texts, emails and calls, and the quotes themselves, word
// for word, dated, newest first. "Add to buy box" files the columns that map
// onto the buy box into their contact record — after showing exactly what it
// will add — because the record is what deals go out on. "Read again" re-reads
// their whole thread (one model call).

import React, { useMemo, useState } from "react";
import { MessageSquare, Phone, Mail, RefreshCw, Plus, Loader2 } from "lucide-react";
import { READ_FIELDS, READ_FIELD_KEYS, fieldText, priceBand, readFacts } from "@shared/investor-read.js";
import { FACT_KEYS } from "@shared/contact-record.js";
import { saveContactFacts, runInvestorReads } from "./api.js";

const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";
const CHANNEL = {
  sms: { Icon: MessageSquare, word: "text" },
  chat: { Icon: MessageSquare, word: "chat" },
  email: { Icon: Mail, word: "email" },
  call: { Icon: Phone, word: "call" },
  voicemail: { Icon: Phone, word: "voicemail" },
};
const fmtDay = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};

// What the record already holds, keyed the way readFacts compares: a scalar a
// person set is never overwritten, a list only gains what it lacks.
export function haveFromBuybox(b = {}) {
  return {
    buybox_areas: b.areas || [],
    buybox_property_types: b.propertyTypes || [],
    buybox_price_min: b.priceMin ?? "",
    buybox_price_max: b.priceMax ?? "",
    rehab_appetite: b.rehabAppetite || "",
    buybox_lot_min: b.lotMin ?? "",
    buybox_exclusions: String(b.exclusions || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean),
  };
}

export default function InvestorWords({ investor, read, onChanged }) {
  const [adding, setAdding] = useState(null); // null | { facts } | { busy } | { done } | { error }
  const [reading, setReading] = useState(null); // null | { busy } | { started } | { error }

  const rows = useMemo(() => {
    if (!read) return [];
    const f = read.fields || {};
    const out = [];
    const price = priceBand(f);
    for (const key of READ_FIELD_KEYS) {
      if (key === "price_max") continue;
      if (key === "price_min") { if (price) out.push(["Price", price]); continue; }
      const t = fieldText(key, f[key]);
      if (t) out.push([READ_FIELDS[key].label, t]);
    }
    return out;
  }, [read]);
  const quotes = useMemo(() => [...(read?.quotes || [])].sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))), [read]);
  const toAdd = useMemo(() => readFacts(read, { have: haveFromBuybox(investor.buybox) }), [read, investor.buybox]);

  if (read === undefined) return <p className="text-sm text-slate-400"><Loader2 size={12} className="mr-1 inline animate-spin" />Loading what they said…</p>;

  const readAgain = async () => {
    setReading({ busy: true });
    try {
      await runInvestorReads({ contactIds: [investor.contactId], dryRun: false });
      setReading({ started: true });
      // One thread reads in well under a minute; the row picks it up on the next load.
      setTimeout(() => onChanged?.(), 45000);
    } catch (e) { setReading({ error: e.message }); }
  };
  const addToBuybox = async () => {
    setAdding({ busy: true });
    try {
      await saveContactFacts(investor.contactId, { party: "investor", add: toAdd });
      setAdding({ done: toAdd.length });
      onChanged?.();
    } catch (e) { setAdding({ error: e.message }); }
  };

  const empty = !read || (!quotes.length && !rows.length && !read.summary);
  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={LABEL_CLS + " mb-0"}>In their words</span>
        {read?.readAt && (
          <span className="text-xs text-slate-400" title={read.by ? `Read by ${read.by}` : ""}>
            read {fmtDay(read.readAt)}{read.through ? ` · thread through ${fmtDay(read.through)}` : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {toAdd.length > 0 && !adding && (
            <button type="button" onClick={() => setAdding({ facts: toAdd })}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-0.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <Plus size={11} /> Add to buy box
            </button>
          )}
          <button type="button" onClick={readAgain} disabled={reading?.busy || reading?.started}
            title="Read their whole thread again (one AI call)"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-0.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw size={11} className={reading?.busy ? "animate-spin" : ""} /> {reading?.started ? "Reading…" : "Read again"}
          </button>
        </span>
      </div>
      {reading?.error && <p className="mb-2 text-xs text-red-700">{reading.error}</p>}

      {adding?.facts && (
        <div className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">
          <p className="mb-1 font-semibold">Add to their buy box?</p>
          <ul className="mb-2 list-disc pl-5 text-xs">
            {adding.facts.map((f, i) => <li key={i}>{FACT_KEYS[f.key]?.label || f.key}: {f.value}</li>)}
          </ul>
          <p className="mb-2 text-xs text-blue-800">Deals go out on the buy box, so these change which deals they're sent. Anything already set stays as it is.</p>
          <div className="flex gap-2">
            <button type="button" onClick={addToBuybox} className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700">Add {adding.facts.length}</button>
            <button type="button" onClick={() => setAdding(null)} className="rounded-lg px-2.5 py-1 text-xs font-semibold text-blue-800 hover:bg-blue-100">Cancel</button>
          </div>
        </div>
      )}
      {adding?.busy && <p className="mb-2 text-xs text-slate-500">Adding…</p>}
      {adding?.done != null && <p className="mb-2 text-xs text-emerald-700">Added {adding.done} to their buy box.</p>}
      {adding?.error && <p className="mb-2 text-xs text-red-700">{adding.error}</p>}

      {empty ? (
        <p className="text-sm text-slate-400">
          {read ? "Nothing in their messages yet about what they buy." : "Not read yet. Read again reads their whole thread."}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div>
            {read.summary && <p className="mb-2 text-sm font-medium text-slate-900">{read.summary}</p>}
            <dl className="space-y-1 text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-36 shrink-0 text-slate-500">{k}</dt>
                  <dd className="min-w-0 text-slate-900">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {quotes.map((q, i) => {
              const ch = CHANNEL[q.channel] || CHANNEL.sms;
              return (
                <li key={i} className="border-l-2 border-slate-200 pl-3">
                  <p className="text-sm text-slate-800">“{q.text}”</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                    <ch.Icon size={11} /> {ch.word} · {fmtDay(q.at)}
                    {(q.about || []).map((k) => (
                      <span key={k} className="rounded bg-slate-100 px-1 text-slate-600">{READ_FIELDS[k]?.label || k}</span>
                    ))}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
