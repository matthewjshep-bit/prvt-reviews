import React, { useState } from "react";
import { API_BASE } from "./api.js";

/*
  WorkflowModal — copy-paste instructions to drive this card from a GoHighLevel
  workflow: Webhook (renders + writes card_image_url) → Wait → MMS attaching
  {{contact.card_image_url}} → rest of the workflow.
*/
function Copy({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}
      className="shrink-0 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
    >
      {done ? "Copied ✓" : "Copy"}
    </button>
  );
}

export default function WorkflowModal({ onClose, templateName, templateId, saved }) {
  const webhookUrl = `${API_BASE}/api/render/webhook`;
  const body = JSON.stringify(
    { templateName: templateName || "My template", contactId: "{{contact.id}}", locationId: "{{location.id}}" },
    null,
    2
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold">Use this card in a GoHighLevel workflow</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        {!saved && (
          <div className="mb-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
            Save this template first so the workflow can reference it by name.
          </div>
        )}

        <p className="mb-3 text-sm text-gray-600">
          The card becomes step 1 of your workflow: a webhook renders it for each contact and stores the image URL on
          the contact; a short wait lets it finish; your MMS step attaches it. Then the workflow continues as normal.
        </p>

        <ol className="space-y-3 text-sm text-gray-800">
          <li>
            <div className="font-semibold">1. Add a “Webhook” action (POST)</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-gray-100 px-2 py-1 text-xs">{webhookUrl}</code>
              <Copy text={webhookUrl} />
            </div>
          </li>
          <li>
            <div className="font-semibold">2. Set the request body (JSON)</div>
            <div className="mt-1 flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-auto rounded bg-gray-100 px-2 py-1 text-xs">{body}</pre>
              <Copy text={body} />
            </div>
            <div className="mt-1 text-xs text-gray-500">
              Template: <span className="font-mono">{templateName}</span>
              {templateId ? <> · id <span className="font-mono">{templateId.slice(0, 8)}…</span></> : null}. GHL fills{" "}
              <span className="font-mono">{"{{contact.id}}"}</span> and <span className="font-mono">{"{{location.id}}"}</span> automatically.
            </div>
          </li>
          <li>
            <div className="font-semibold">3. Add a “Wait” step — 30 seconds</div>
            <div className="text-xs text-gray-500">Gives the render time to finish and save the image URL.</div>
          </li>
          <li>
            <div className="font-semibold">4. Add your SMS/MMS step</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-gray-100 px-2 py-1 text-xs">{"{{contact.card_image_url}}"}</code>
              <Copy text="{{contact.card_image_url}}" />
            </div>
            <div className="mt-1 text-xs text-gray-500">Attach that as the media/image, then write your message.</div>
          </li>
          <li>
            <div className="font-semibold">5. Continue your workflow</div>
            <div className="text-xs text-gray-500">Add any subsequent steps after the MMS as usual.</div>
          </li>
        </ol>

        <div className="mt-4 rounded-lg bg-gray-50 p-2 text-[11px] text-gray-500">
          The webhook auto-creates the contact field <span className="font-mono">card_image_url</span> if it doesn’t exist.
          It renders the same design you see here, personalized per contact (their address, name, map, etc.).
        </div>
      </div>
    </div>
  );
}
