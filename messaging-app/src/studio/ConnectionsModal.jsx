import React, { useEffect, useState } from "react";
import * as api from "./api.js";

/*
  ConnectionsModal — location-scoped credential manager. Secrets are write-only:
  after save the API only ever returns the name/provider/type, never the value
  (they're AES-256-GCM encrypted at rest in the broker). Used by data sources
  whose provider needs a header/token/webhook URL.
*/
export default function ConnectionsModal({ onClose }) {
  const [list, setList] = useState([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("header");
  const [provider, setProvider] = useState("generic-http");
  const [headerKey, setHeaderKey] = useState("");
  const [headerVal, setHeaderVal] = useState("");
  const [token, setToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = () => api.listConnections().then(setList).catch(() => setList([]));
  useEffect(() => { refresh(); }, []);

  async function create() {
    setErr(""); setBusy(true);
    try {
      const secret =
        type === "bearer" ? { token }
        : type === "webhook" ? { webhookUrl }
        : { headers: headerKey ? { [headerKey]: headerVal } : {} };
      await api.createConnection({ name, provider, type, secret });
      setName(""); setToken(""); setHeaderKey(""); setHeaderVal(""); setWebhookUrl("");
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id) {
    await api.deleteConnection(id).catch(() => {});
    refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold">Connections</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        <div className="mb-4 max-h-40 overflow-auto rounded-lg border border-gray-200">
          {list.length === 0 && <div className="px-3 py-2 text-xs text-gray-400">No connections yet</div>}
          {list.map((c) => (
            <div key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span><span className="font-medium">{c.name}</span> <span className="text-gray-400">· {c.type} · ••••</span></span>
              <button type="button" onClick={() => remove(c.id)} className="text-xs text-gray-400 hover:text-red-500">Delete</button>
            </div>
          ))}
        </div>

        <div className="space-y-2 rounded-lg border border-gray-200 p-3">
          <div className="text-xs font-bold uppercase tracking-wide text-gray-400">New connection</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Rentcast API)" className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
          <div className="grid grid-cols-2 gap-2">
            <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm">
              <option value="header">Header key/value</option>
              <option value="bearer">Bearer token</option>
              <option value="webhook">Webhook URL</option>
            </select>
            <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="provider id or generic-http" className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          {type === "header" && (
            <div className="grid grid-cols-2 gap-2">
              <input value={headerKey} onChange={(e) => setHeaderKey(e.target.value)} placeholder="Header name (X-Api-Key)" className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
              <input value={headerVal} onChange={(e) => setHeaderVal(e.target.value)} placeholder="Value" type="password" className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
            </div>
          )}
          {type === "bearer" && <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token" type="password" className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm" />}
          {type === "webhook" && <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hook.make.com/…" className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm" />}
          {err && <div className="text-xs text-red-500">{err}</div>}
          <button type="button" onClick={create} disabled={busy || !name} className="w-full rounded-lg py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: "#16a34a" }}>
            {busy ? "Saving…" : "Add connection"}
          </button>
          <p className="text-[11px] text-gray-400">Secrets are encrypted and never shown again after saving.</p>
        </div>
      </div>
    </div>
  );
}
