import React, { useState, useEffect } from 'react';
import { X, Search, Phone, Mail, Trash2, UserPlus, Link as LinkIcon } from 'lucide-react';
import { 
  updateOpportunity, 
  createOpportunity, 
  searchContacts, 
  getLinkedContacts, 
  addLinkedContact, 
  removeLinkedContact 
} from './api';

export default function Drawer({ open, onClose, card, stages, onSave }) {
  const isCreateMode = card && !card.id;
  
  const [name, setName] = useState('');
  const [stageId, setStageId] = useState('');
  const [monetaryValue, setMonetaryValue] = useState('');
  const [notes, setNotes] = useState('');
  
  // The primary contact is handled natively by GHL.
  // In create mode, they pick the primary contact here.
  const [primaryContactId, setPrimaryContactId] = useState('');
  const [primaryContactName, setPrimaryContactName] = useState('');
  
  // Multiple Linked Contacts (Supabase)
  const [linkedContacts, setLinkedContacts] = useState([]);
  const [contactSearch, setContactSearch] = useState('');
  const [contactResults, setContactResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const locationId = new URLSearchParams(window.location.search).get("locationId");
  const getContactUrl = (cid) => `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${cid}`;

  // Load linked contacts if in edit mode
  useEffect(() => {
    if (open && card && card.id) {
      getLinkedContacts(card.id).then(contacts => {
        // GHL native primary contact might not be in Supabase, let's inject it at the top 
        // to represent all contacts in one unified list if they want.
        setLinkedContacts(contacts);
      }).catch(err => console.error(err));
    }
  }, [open, card]);

  // Debounced contact search
  useEffect(() => {
    if (contactSearch.length < 3) {
      setContactResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const results = await searchContacts(contactSearch);
        // Filter out contacts that are already linked
        const existingIds = new Set(linkedContacts.map(c => c.contact_id));
        if (primaryContactId) existingIds.add(primaryContactId);
        if (card && card.contact && card.contact.id) existingIds.add(card.contact.id);
        
        setContactResults(results.filter(r => !existingIds.has(r.id)));
      } catch (err) {
        console.error(err);
      } finally {
        setIsSearching(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [contactSearch, linkedContacts, primaryContactId, card]);

  useEffect(() => {
    if (card) {
      setName(card.name || '');
      setStageId(card.stageId || '');
      setMonetaryValue(card.monetaryValue || 0);
      setNotes(card.notes || '');
      
      if (card.contact) {
        setPrimaryContactId(card.contact.id || '');
        setPrimaryContactName(card.contact.name || '');
      } else {
        setPrimaryContactId('');
        setPrimaryContactName('');
      }
      setContactSearch('');
      setContactResults([]);
      setError(null);
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
        monetaryValue: parseFloat(monetaryValue) || 0,
        notes,
      };
      
      let updated;
      if (isCreateMode) {
        if (!primaryContactId) throw new Error("Please select a primary contact to link this opportunity to.");
        payload.contactId = primaryContactId;
        updated = await createOpportunity(payload);
        
        // Link any additional contacts they added during creation to Supabase
        for (const c of linkedContacts) {
          await addLinkedContact(updated.id, {
            id: c.contact_id,
            name: c.contact_name,
            email: c.contact_email,
            phone: c.contact_phone
          });
        }
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

  const handleLinkContact = async (contact) => {
    if (isCreateMode) {
      if (!primaryContactId) {
        setPrimaryContactId(contact.id);
        setPrimaryContactName(contact.name);
        if (!name) setName(`${contact.name} Reactivation`);
      } else {
        setLinkedContacts([...linkedContacts, {
          contact_id: contact.id,
          contact_name: contact.name,
          contact_email: contact.email,
          contact_phone: contact.phone
        }]);
      }
    } else {
      // Edit mode: save to Supabase immediately
      try {
        await addLinkedContact(card.id, contact);
        setLinkedContacts([...linkedContacts, {
          contact_id: contact.id,
          contact_name: contact.name,
          contact_email: contact.email,
          contact_phone: contact.phone
        }]);
      } catch (err) {
        setError(err.message);
      }
    }
    setContactSearch('');
    setContactResults([]);
  };

  const handleUnlinkContact = async (contactId) => {
    if (!isCreateMode) {
      try {
        await removeLinkedContact(card.id, contactId);
      } catch (err) {
        setError(err.message);
        return;
      }
    }
    setLinkedContacts(linkedContacts.filter(c => c.contact_id !== contactId));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={onClose} />
      
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden transform transition-all">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gray-50/50">
          <h2 className="text-xl font-bold text-gray-900">
            {isCreateMode ? 'Create New Opportunity' : 'Opportunity Details'}
          </h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          <form id="opp-form" onSubmit={handleSubmit} className="p-6 flex flex-col md:flex-row gap-8">
            
            {/* Left Column: Opportunity Details */}
            <div className="flex-1 space-y-6">
              {error && <div className="p-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl">{error}</div>}

              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-1.5">Opportunity Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm transition-shadow"
                  placeholder="e.g. John Doe Reactivation"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">Pipeline Stage</label>
                  <select
                    value={stageId}
                    onChange={(e) => setStageId(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                  >
                    {stages.map((stage) => (
                      <option key={stage.stageId} value={stage.stageId}>
                        {stage.stageName}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">Monetary Value ($)</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                      <span className="text-gray-500 font-medium">$</span>
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      value={monetaryValue}
                      onChange={(e) => setMonetaryValue(e.target.value)}
                      className="w-full border border-gray-200 rounded-xl pl-8 pr-4 py-3 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-1.5">Notes / Activity log</label>
                <textarea
                  rows={6}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none shadow-sm"
                  placeholder="Add details about this reactivation..."
                />
              </div>
            </div>

            {/* Right Column: Linked Contacts */}
            <div className="w-full md:w-[340px] space-y-6">
              <div>
                <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wider flex items-center gap-2 mb-4">
                  <UserPlus className="w-4 h-4 text-gray-400" />
                  Linked Contacts
                </h3>
                
                {/* Search / Add Contact */}
                <div className="relative mb-4">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Search className="h-4 w-4 text-gray-400" />
                  </div>
                  <input
                    type="text"
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                    placeholder="Search CRM to link..."
                    className="w-full border border-gray-200 rounded-xl pl-9 pr-3 py-2.5 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-gray-50"
                  />
                  {isSearching && (
                    <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                      <div className="animate-spin h-4 w-4 border-2 border-blue-600 border-t-transparent rounded-full"></div>
                    </div>
                  )}
                  {contactResults.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-xl max-h-60 overflow-auto">
                      {contactResults.map(contact => (
                        <button
                          key={contact.id}
                          type="button"
                          onClick={() => handleLinkContact(contact)}
                          className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-0"
                        >
                          <div className="font-medium text-gray-900">{contact.name}</div>
                          <div className="text-xs text-gray-500 flex gap-2 mt-0.5">
                            {contact.email && <span>{contact.email}</span>}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Contacts List */}
                <div className="space-y-3">
                  {/* Primary Contact */}
                  {(primaryContactId || (card && card.contact)) && (
                    <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-4 relative group">
                      <div className="absolute top-0 right-0 px-2 py-1 bg-blue-100 text-blue-700 text-[10px] font-bold uppercase rounded-bl-lg rounded-tr-xl">
                        Primary
                      </div>
                      <a 
                        href={getContactUrl(primaryContactId || card?.contact?.id)} 
                        target="_blank" 
                        rel="noreferrer"
                        className="font-semibold text-gray-900 hover:text-blue-600 transition-colors cursor-pointer"
                      >
                        {primaryContactName || card?.contact?.name}
                      </a>
                      
                      {((card?.contact?.phone) || (card?.contact?.email)) && (
                        <div className="mt-3 space-y-2">
                          {card?.contact?.phone && (
                            <a href={`tel:${card.contact.phone}`} className="flex items-center gap-2 text-sm text-gray-600 hover:text-blue-600 transition-colors">
                              <Phone className="w-3.5 h-3.5" />
                              {card.contact.phone}
                            </a>
                          )}
                          {card?.contact?.email && (
                            <a href={`mailto:${card.contact.email}`} className="flex items-center gap-2 text-sm text-gray-600 hover:text-blue-600 transition-colors">
                              <Mail className="w-3.5 h-3.5" />
                              {card.contact.email}
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Secondary Contacts (Supabase) */}
                  {linkedContacts.map(contact => (
                    <div key={contact.contact_id} className="bg-white border border-gray-200 rounded-xl p-4 relative group hover:border-gray-300 transition-colors">
                      <div className="absolute top-0 right-0 px-2 py-1 bg-gray-100 text-gray-500 text-[10px] font-bold uppercase rounded-bl-lg rounded-tr-xl flex items-center gap-1">
                        <LinkIcon className="w-3 h-3" /> Linked
                      </div>
                      <a 
                        href={getContactUrl(contact.contact_id)} 
                        target="_blank" 
                        rel="noreferrer"
                        className="font-semibold text-gray-900 hover:text-blue-600 transition-colors cursor-pointer"
                      >
                        {contact.contact_name}
                      </a>
                      
                      {(contact.contact_phone || contact.contact_email) && (
                        <div className="mt-3 space-y-2">
                          {contact.contact_phone && (
                            <a href={`tel:${contact.contact_phone}`} className="flex items-center gap-2 text-sm text-gray-600 hover:text-blue-600 transition-colors">
                              <Phone className="w-3.5 h-3.5" />
                              {contact.contact_phone}
                            </a>
                          )}
                          {contact.contact_email && (
                            <a href={`mailto:${contact.contact_email}`} className="flex items-center gap-2 text-sm text-gray-600 hover:text-blue-600 transition-colors">
                              <Mail className="w-3.5 h-3.5" />
                              {contact.contact_email}
                            </a>
                          )}
                        </div>
                      )}
                      
                      <button 
                        type="button" 
                        onClick={() => handleUnlinkContact(contact.contact_id)}
                        className="absolute bottom-3 right-3 p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                        title="Unlink Contact"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  
                  {isCreateMode && !primaryContactId && (
                    <div className="text-center p-6 border-2 border-dashed border-gray-200 rounded-xl text-gray-400 text-sm">
                      Search above to link the primary contact.
                    </div>
                  )}
                </div>
              </div>

            </div>
          </form>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-100 flex justify-end gap-3 bg-gray-50/50">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-semibold text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            form="opp-form"
            type="submit"
            disabled={saving}
            className="px-6 py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 shadow-sm transition-all flex items-center justify-center min-w-[120px]"
          >
            {saving ? (
              <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
            ) : (
              'Save Changes'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
