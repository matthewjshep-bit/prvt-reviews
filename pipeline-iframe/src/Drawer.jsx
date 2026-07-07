import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { updateOpportunity } from './api';

export default function Drawer({ open, onClose, card, stages, onSave }) {
  const [stageId, setStageId] = useState('');
  const [monetaryValue, setMonetaryValue] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (card) {
      // Find the stage ID by the column the card is in, but actually card doesn't have stageId directly?
      // Wait, card is passed in. In Board, columns have stageId. 
      // We will pass the current stageId to Drawer as well.
      setStageId(card.stageId || '');
      setMonetaryValue(card.monetaryValue || 0);
      setNotes(card.notes || '');
    }
  }, [card]);

  if (!open || !card) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        stageId,
        monetaryValue: parseFloat(monetaryValue) || 0,
        notes,
      };
      const updated = await updateOpportunity(card.id, payload);
      // Pass the updated card and new stageId back to parent
      onSave(updated, stageId);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40 transition-opacity" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-sm bg-white shadow-xl flex flex-col transform transition-transform">
        <div className="flex items-center justify-between px-4 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Edit Opportunity</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-500 rounded-full hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 space-y-6">
          {error && <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}

          <div>
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-3">Contact</h3>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="font-medium text-gray-900">{card.contact?.name || card.name}</div>
              {card.contact?.phone && (
                <a href={`tel:${card.contact.phone}`} className="text-sm text-blue-600 hover:underline mt-1 block">
                  {card.contact.phone}
                </a>
              )}
              {card.contact?.email && (
                <div className="text-sm text-gray-500 mt-1">{card.contact.email}</div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Pipeline Stage</label>
            <select
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {stages.map((stage) => (
                <option key={stage.stageId} value={stage.stageId}>
                  {stage.stageName}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Monetary Value ($)</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <span className="text-gray-500 sm:text-sm">$</span>
              </div>
              <input
                type="number"
                step="0.01"
                value={monetaryValue}
                onChange={(e) => setMonetaryValue(e.target.value)}
                className="w-full border border-gray-300 rounded-lg pl-7 pr-3 py-2 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
              placeholder="Add details about this reactivation..."
            />
          </div>
        </form>

        <div className="p-4 border-t border-gray-100 flex justify-end gap-3 bg-gray-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </>
  );
}
