import React, { useRef, useState } from "react";

/*
  FieldWithTags — a text input/textarea with a "{ } Insert field" button that
  opens the merge-tag picker and inserts {{scope.path}} at the cursor. `groups`
  comes from model.mergeTagGroups (standard contact fields → live custom fields
  → loc.* → discovered data.<id>.* keys).
*/
export default function FieldWithTags({ value, onChange, groups = [], label, placeholder, multiline = false, rows = 3 }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);

  function insert(token) {
    const el = ref.current;
    const t = `{{${token}}}`;
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? value.length;
    const next = value.slice(0, s) + t + value.slice(e);
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = s + t.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const Input = multiline ? "textarea" : "input";
  return (
    <div className="relative">
      {label && (
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-700">{label}</span>
          <button type="button" onClick={() => setOpen((o) => !o)} className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50">
            {"{ }"} Insert field
          </button>
        </div>
      )}
      <Input
        ref={ref}
        value={value}
        rows={multiline ? rows : undefined}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
      />
      {!label && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="absolute right-1.5 top-1.5 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50">
          {"{ }"}
        </button>
      )}
      {open && (
        <div className="absolute right-0 z-30 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-gray-200 bg-white p-2 shadow-xl">
          {groups.map((g) => (
            <div key={g.group} className="mb-2 last:mb-0">
              <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">{g.group}</div>
              {g.tags.length === 0 && <div className="px-1 text-[11px] text-gray-400">None</div>}
              {g.tags.map((t) => (
                <button key={t.token} type="button" onClick={() => insert(t.token)} className="flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-xs hover:bg-green-50">
                  <span className="font-medium text-gray-800">{t.label}</span>
                  <span className="ml-2 truncate font-mono text-[10px] text-gray-400">{t.token}</span>
                </button>
              ))}
            </div>
          ))}
          <button type="button" onClick={() => setOpen(false)} className="mt-1 w-full rounded bg-gray-100 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-200">Close</button>
        </div>
      )}
    </div>
  );
}
