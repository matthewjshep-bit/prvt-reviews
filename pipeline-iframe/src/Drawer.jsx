import React, { useState, useEffect } from 'react';
import { X, Search } from 'lucide-react';
import { updateOpportunity, createOpportunity, searchContacts } from './api';

export default function Drawer({ open, onClose, card, stages, onSave }) {
  const isCreateMode = card && !card.id;
  
  const [name, setName] = useState('');
  const [stageId, setStageId] = useState('');
  const [monetaryValue, setMonetaryValue] = useState('');
  const [notes, setNotes] = useState('');
  
  const [contactId, setContactId] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [contactResults, setContactResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Debounced search
  useEffect(() => {
    if (!isCreateMode || contactSearch.length < 3) {
      setContactResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const results = await searchContacts(contactSearch);
        setContactResults(results);
      } catch (err) {
        console.error(err);
      } finally {
        setIsSearching(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [contactSearch, isCreateMode]);

  useEffect(() => {
    if (card) {
      setName(card.name || '');
      setStageId(card.stageId || '');
      setMonetaryValue(card.monetaryValue || 0);
      setNotes(card.notes || '');
      
      if (card.contact) {
        setContactId(card.contact.id || '');
        setContactName(card.contact.name || '');
      } else {
        setContactId('');
        setContactName('');
      }
      setContactSearch('');
      setContactResults([]);
    }
  }, [card]);

  if (!open || !card) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        stageId,
        contactId: isCreateMode ? contactId : undefined,
        monetaryValue: parseFloat(monetaryValue) || 0,
        notes,
      };
      
      let updated;
      if (isCreateMode) {
        if (!contactId) throw new Error("Please select a contact to link this opportunity to.");
        updated = await createOpportunity(payload);
      } else {
        updated = await updateOpportunity(card.id, payload);
      }
      
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
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-xl flex flex-col transform transition-transform">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-xl font-semibold text-gray-900">
            {isCreateMode ? 'Create Opportunity' : 'Edit Opportunity'}
          </h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-500 rounded-full hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6">
          {error && <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}

          {isCreateMode && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Opportunity Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="e.g. John Doe Reactivation"
                required
              />
            </div>
          )}

          <div>
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-3">Linked Contact</h3>
            {!isCreateMode ? (
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
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
            ) : (
              <div className="space-y-3">
                {contactId ? (
                  <div className="flex items-center justify-between bg-blue-50 border border-blue-100 rounded-lg p-3">
                    <div className="font-medium text-blue-900">{contactName}</div>
                    <button type="button" onClick={() => { setContactId(''); setContactName(''); }} className="text-blue-600 hover:text-blue-800 text-sm font-medium">
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Search className="h-4 w-4 text-gray-400" />
                    </div>
                    <input
                      type="text"
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      placeholder="Search CRM by name, email, or phone..."
                      className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    {isSearching && (
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                        <div className="animate-spin h-4 w-4 border-2 border-blue-600 border-t-transparent rounded-full"></div>
                      </div>
                    )}
                    {contactResults.length > 0 && !contactId && (
                      <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-auto">
                        {contactResults.map(contact => (
                          <button
                            key={contact.id}
                            type="button"
                            onClick={() => {
                              setContactId(contact.id);
                              setContactName(contact.name);
                              if (!name) setName(`${contact.name} Reactivation`);
                              setContactSearch('');
                              setContactResults([]);
                            }}
                            className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-0"
                          >
                            <div className="font-medium text-gray-900">{contact.name}</div>
                            <div className="text-xs text-gray-500 flex gap-2 mt-0.5">
                              {contact.email && <span>{contact.email}</span>}
                              {contact.phone && <span>{contact.phone}</span>}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
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
