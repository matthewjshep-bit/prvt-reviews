import React, { useState, useEffect } from 'react';
import { X, Search, Phone, Mail, Trash2, UserPlus, Link as LinkIcon, Plus, Check, Circle, Tag, StickyNote, ListTodo, ExternalLink } from 'lucide-react';
import { 
  updateOpportunity, createOpportunity, searchContacts, 
  getLinkedContacts, addLinkedContact, removeLinkedContact,
  fetchContactNotes, createNote,
  fetchContactTasks, createTask, toggleTask,
  fetchContactTags, addTag, deleteTag,
  fetchContactOpportunities
} from './api';

const TAG_COLORS = [
  'bg-blue-100 text-blue-700', 'bg-emerald-100 text-emerald-700', 'bg-purple-100 text-purple-700',
  'bg-amber-100 text-amber-700', 'bg-rose-100 text-rose-700', 'bg-cyan-100 text-cyan-700',
  'bg-orange-100 text-orange-700', 'bg-indigo-100 text-indigo-700'
];

export default function Drawer({ open, onClose, card, stages, onSave }) {
  const isCreateMode = card && !card.id;
  
  const [name, setName] = useState('');
  const [stageId, setStageId] = useState('');
  const [monetaryValue, setMonetaryValue] = useState('');
  const [notes, setNotes] = useState('');
  
  const [primaryContactId, setPrimaryContactId] = useState('');
  const [primaryContactName, setPrimaryContactName] = useState('');
  
  const [linkedContacts, setLinkedContacts] = useState([]);
  const [contactSearch, setContactSearch] = useState('');
  const [contactResults, setContactResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  
  // Activity panel state
  const [contactNotes, setContactNotes] = useState([]);
  const [newNoteText, setNewNoteText] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  
  const [contactTasks, setContactTasks] = useState([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDue, setNewTaskDue] = useState('');
  const [addingTask, setAddingTask] = useState(false);
  
  const [tags, setTags] = useState([]);
  const [newTagText, setNewTagText] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  
  const [relatedOpps, setRelatedOpps] = useState([]);
  
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const locationId = new URLSearchParams(window.location.search).get("locationId");
  const getContactUrl = (cid) => `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${cid}`;

  // Load activity data when card opens in edit mode
  useEffect(() => {
    if (!open || !card) return;
    
    if (card.id) {
      getLinkedContacts(card.id).then(setLinkedContacts).catch(console.error);
    }
    
    const cid = card.contact?.id || card.contactId;
    if (cid) {
      fetchContactNotes(cid).then(setContactNotes).catch(console.error);
      fetchContactTasks(cid).then(setContactTasks).catch(console.error);
      fetchContactTags(cid).then(setTags).catch(console.error);
      fetchContactOpportunities(cid).then(opps => {
        // Filter out the current opportunity
        setRelatedOpps(opps.filter(o => o.id !== card.id));
      }).catch(console.error);
    }
  }, [open, card]);

  // Debounced contact search
  useEffect(() => {
    if (contactSearch.length < 3) { setContactResults([]); return; }
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const results = await searchContacts(contactSearch);
        const existingIds = new Set(linkedContacts.map(c => c.contact_id));
        if (primaryContactId) existingIds.add(primaryContactId);
        if (card?.contact?.id) existingIds.add(card.contact.id);
        setContactResults(results.filter(r => !existingIds.has(r.id)));
      } catch (err) { console.error(err); }
      finally { setIsSearching(false); }
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
        setPrimaryContactId(''); setPrimaryContactName('');
      }
      setContactSearch(''); setContactResults([]);
      setError(null); setContactNotes([]); setContactTasks([]);
      setTags([]); setRelatedOpps([]); setLinkedContacts([]);
    }
  }, [card]);

  if (!open || !card) return null;

  const activeContactId = primaryContactId || card?.contact?.id;

  // --- Handlers ---
  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const payload = { name, stageId, monetaryValue: parseFloat(monetaryValue) || 0, notes };
      let updated;
      if (isCreateMode) {
        if (!primaryContactId) throw new Error("Please select a primary contact.");
        payload.contactId = primaryContactId;
        updated = await createOpportunity(payload);
        for (const c of linkedContacts) {
          await addLinkedContact(updated.id, { id: c.contact_id, name: c.contact_name, email: c.contact_email, phone: c.contact_phone });
        }
      } else {
        updated = await updateOpportunity(card.id, payload);
      }
      onSave(updated, stageId); onClose();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleLinkContact = async (contact) => {
    if (isCreateMode && !primaryContactId) {
      setPrimaryContactId(contact.id); setPrimaryContactName(contact.name);
      if (!name) setName(`${contact.name} Reactivation`);
    } else if (isCreateMode) {
      setLinkedContacts([...linkedContacts, { contact_id: contact.id, contact_name: contact.name, contact_email: contact.email, contact_phone: contact.phone }]);
    } else {
      try {
        await addLinkedContact(card.id, contact);
        setLinkedContacts([...linkedContacts, { contact_id: contact.id, contact_name: contact.name, contact_email: contact.email, contact_phone: contact.phone }]);
      } catch (err) { setError(err.message); }
    }
    setContactSearch(''); setContactResults([]);
  };

  const handleUnlinkContact = async (contactId) => {
    if (!isCreateMode) { try { await removeLinkedContact(card.id, contactId); } catch (err) { setError(err.message); return; } }
    setLinkedContacts(linkedContacts.filter(c => c.contact_id !== contactId));
  };

  const handleAddNote = async () => {
    if (!newNoteText.trim() || !activeContactId) return;
    setAddingNote(true);
    try {
      const note = await createNote(activeContactId, { body: newNoteText.trim() });
      setContactNotes([note, ...contactNotes]);
      setNewNoteText('');
    } catch (err) { setError(err.message); }
    finally { setAddingNote(false); }
  };

  const handleAddTask = async () => {
    if (!newTaskTitle.trim() || !activeContactId) return;
    setAddingTask(true);
    try {
      const body = { title: newTaskTitle.trim(), dueDate: newTaskDue || undefined };
      const task = await createTask(activeContactId, body);
      setContactTasks([task, ...contactTasks]);
      setNewTaskTitle(''); setNewTaskDue('');
    } catch (err) { setError(err.message); }
    finally { setAddingTask(false); }
  };

  const handleToggleTask = async (task) => {
    if (!activeContactId) return;
    const newCompleted = !task.completed;
    try {
      await toggleTask(activeContactId, task.id, { completed: newCompleted });
      setContactTasks(contactTasks.map(t => t.id === task.id ? { ...t, completed: newCompleted } : t));
    } catch (err) { setError(err.message); }
  };

  const handleAddTag = async () => {
    if (!newTagText.trim() || !activeContactId) return;
    setAddingTag(true);
    try {
      await addTag(activeContactId, [newTagText.trim()]);
      setTags([...tags, newTagText.trim()]);
      setNewTagText('');
    } catch (err) { setError(err.message); }
    finally { setAddingTag(false); }
  };

  const handleRemoveTag = async (tagName) => {
    if (!activeContactId) return;
    try {
      await deleteTag(activeContactId, [tagName]);
      setTags(tags.filter(t => t !== tagName));
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-7xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50/50 shrink-0">
          <h2 className="text-xl font-bold text-gray-900">
            {isCreateMode ? 'Create New Opportunity' : card.name || 'Opportunity Details'}
          </h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body - 3 columns */}
        <div className="flex-1 overflow-y-auto">
          <form id="opp-form" onSubmit={handleSubmit} className="p-6 flex flex-col lg:flex-row gap-6 min-h-0">
            
            {/* === LEFT COLUMN: Opportunity Details === */}
            <div className="flex-1 min-w-0 space-y-5">
              {error && <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl">{error}</div>}
              
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Opportunity Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm" placeholder="e.g. John Doe Reactivation" required />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Pipeline Stage</label>
                  <select value={stageId} onChange={(e) => setStageId(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 focus:ring-2 focus:ring-blue-500 shadow-sm">
                    {stages.map(s => <option key={s.stageId} value={s.stageId}>{s.stageName}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Monetary Value</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><span className="text-gray-500 font-medium">$</span></div>
                    <input type="number" step="0.01" value={monetaryValue} onChange={(e) => setMonetaryValue(e.target.value)}
                      className="w-full border border-gray-200 rounded-xl pl-7 pr-3 py-2.5 text-gray-900 focus:ring-2 focus:ring-blue-500 shadow-sm" />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Internal Notes</label>
                <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 focus:ring-2 focus:ring-blue-500 resize-none shadow-sm" placeholder="Add details about this reactivation..." />
              </div>
            </div>

            {/* === CENTER COLUMN: Activity (Tags, Notes, Tasks) === */}
            <div className="w-full lg:w-[320px] space-y-5 border-l border-r border-gray-100 lg:px-6">
              
              {/* Tags */}
              <div>
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-3">
                  <Tag className="w-3.5 h-3.5" /> Tags
                </h3>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tags.map((tag, i) => (
                    <span key={tag} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${TAG_COLORS[i % TAG_COLORS.length]}`}>
                      {tag}
                      <button type="button" onClick={() => handleRemoveTag(tag)} className="hover:opacity-70 ml-0.5">&times;</button>
                    </span>
                  ))}
                </div>
                {!isCreateMode && activeContactId && (
                  <div className="flex gap-2">
                    <input type="text" value={newTagText} onChange={(e) => setNewTagText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTag())}
                      placeholder="Add tag..." className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500" />
                    <button type="button" onClick={handleAddTag} disabled={addingTag || !newTagText.trim()}
                      className="px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-600 disabled:opacity-40"><Plus className="w-4 h-4" /></button>
                  </div>
                )}
              </div>

              {/* Notes Timeline */}
              <div>
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-3">
                  <StickyNote className="w-3.5 h-3.5" /> Contact Notes
                </h3>
                {!isCreateMode && activeContactId && (
                  <div className="flex gap-2 mb-3">
                    <input type="text" value={newNoteText} onChange={(e) => setNewNoteText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddNote())}
                      placeholder="Write a note..." className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500" />
                    <button type="button" onClick={handleAddNote} disabled={addingNote || !newNoteText.trim()}
                      className="px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-600 disabled:opacity-40"><Plus className="w-4 h-4" /></button>
                  </div>
                )}
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {contactNotes.length === 0 && !isCreateMode && <p className="text-xs text-gray-400 italic">No notes yet.</p>}
                  {contactNotes.map((note, i) => (
                    <div key={note.id || i} className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                      <p className="text-sm text-gray-800 whitespace-pre-wrap">{note.body}</p>
                      <p className="text-[10px] text-gray-400 mt-1.5">{note.dateAdded ? new Date(note.dateAdded).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tasks */}
              <div>
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-3">
                  <ListTodo className="w-3.5 h-3.5" /> Tasks
                </h3>
                {!isCreateMode && activeContactId && (
                  <div className="flex gap-2 mb-3">
                    <input type="text" value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTask())}
                      placeholder="New task..." className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500" />
                    <input type="date" value={newTaskDue} onChange={(e) => setNewTaskDue(e.target.value)}
                      className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-600 focus:ring-2 focus:ring-blue-500 w-[110px]" />
                    <button type="button" onClick={handleAddTask} disabled={addingTask || !newTaskTitle.trim()}
                      className="px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-600 disabled:opacity-40"><Plus className="w-4 h-4" /></button>
                  </div>
                )}
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {contactTasks.length === 0 && !isCreateMode && <p className="text-xs text-gray-400 italic">No tasks yet.</p>}
                  {contactTasks.map((task, i) => (
                    <div key={task.id || i} className="flex items-start gap-2.5 group">
                      <button type="button" onClick={() => handleToggleTask(task)} className="mt-0.5 shrink-0">
                        {task.completed
                          ? <Check className="w-4 h-4 text-emerald-500" />
                          : <Circle className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                        }
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${task.completed ? 'line-through text-gray-400' : 'text-gray-800'}`}>{task.title || task.body}</p>
                        {task.dueDate && <p className="text-[10px] text-gray-400">{new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* === RIGHT COLUMN: Contacts + Related Opps === */}
            <div className="w-full lg:w-[280px] space-y-5">
              
              {/* Linked Contacts */}
              <div>
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-3">
                  <UserPlus className="w-3.5 h-3.5" /> Linked Contacts
                </h3>
                <div className="relative mb-3">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><Search className="h-3.5 w-3.5 text-gray-400" /></div>
                  <input type="text" value={contactSearch} onChange={(e) => setContactSearch(e.target.value)}
                    placeholder="Search CRM to link..." className="w-full border border-gray-200 rounded-xl pl-8 pr-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 bg-gray-50" />
                  {isSearching && <div className="absolute inset-y-0 right-0 pr-3 flex items-center"><div className="animate-spin h-3.5 w-3.5 border-2 border-blue-600 border-t-transparent rounded-full"></div></div>}
                  {contactResults.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-xl max-h-48 overflow-auto">
                      {contactResults.map(c => (
                        <button key={c.id} type="button" onClick={() => handleLinkContact(c)}
                          className="w-full text-left px-3 py-2.5 hover:bg-gray-50 border-b border-gray-100 last:border-0">
                          <div className="font-medium text-sm text-gray-900">{c.name}</div>
                          <div className="text-[11px] text-gray-500">{c.email}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {(primaryContactId || card?.contact) && (
                    <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-3 relative">
                      <div className="absolute top-0 right-0 px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[9px] font-bold uppercase rounded-bl-lg rounded-tr-xl">Primary</div>
                      <a href={getContactUrl(primaryContactId || card?.contact?.id)} target="_blank" rel="noreferrer"
                        className="font-semibold text-sm text-gray-900 hover:text-blue-600 transition-colors">{primaryContactName || card?.contact?.name}</a>
                      {card?.contact?.phone && <a href={`tel:${card.contact.phone}`} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-600 mt-1.5"><Phone className="w-3 h-3" />{card.contact.phone}</a>}
                      {card?.contact?.email && <a href={`mailto:${card.contact.email}`} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-600 mt-1"><Mail className="w-3 h-3" />{card.contact.email}</a>}
                    </div>
                  )}

                  {linkedContacts.map(c => (
                    <div key={c.contact_id} className="bg-white border border-gray-200 rounded-xl p-3 relative group hover:border-gray-300">
                      <div className="absolute top-0 right-0 px-1.5 py-0.5 bg-gray-100 text-gray-500 text-[9px] font-bold uppercase rounded-bl-lg rounded-tr-xl flex items-center gap-0.5"><LinkIcon className="w-2.5 h-2.5" /> Linked</div>
                      <a href={getContactUrl(c.contact_id)} target="_blank" rel="noreferrer"
                        className="font-semibold text-sm text-gray-900 hover:text-blue-600 transition-colors">{c.contact_name}</a>
                      {c.contact_phone && <a href={`tel:${c.contact_phone}`} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-600 mt-1.5"><Phone className="w-3 h-3" />{c.contact_phone}</a>}
                      {c.contact_email && <a href={`mailto:${c.contact_email}`} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-600 mt-1"><Mail className="w-3 h-3" />{c.contact_email}</a>}
                      <button type="button" onClick={() => handleUnlinkContact(c.contact_id)}
                        className="absolute bottom-2 right-2 p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg opacity-0 group-hover:opacity-100"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}

                  {isCreateMode && !primaryContactId && (
                    <div className="text-center p-4 border-2 border-dashed border-gray-200 rounded-xl text-gray-400 text-xs">
                      Search above to link the primary contact.
                    </div>
                  )}
                </div>
              </div>

              {/* Related Opportunities */}
              {!isCreateMode && relatedOpps.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-3">
                    <ExternalLink className="w-3.5 h-3.5" /> Related Opportunities
                  </h3>
                  <div className="space-y-2">
                    {relatedOpps.map(opp => (
                      <div key={opp.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3">
                        <div className="font-medium text-sm text-gray-900">{opp.name}</div>
                        <div className="flex items-center justify-between mt-1.5">
                          <span className="text-[11px] text-gray-500 capitalize">{opp.status}</span>
                          {opp.monetaryValue > 0 && <span className="text-xs font-semibold text-emerald-600">${opp.monetaryValue.toLocaleString()}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </form>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-100 flex justify-end gap-3 bg-gray-50/50 shrink-0">
          <button type="button" onClick={onClose} className="px-5 py-2 text-sm font-semibold text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-xl">Cancel</button>
          <button form="opp-form" type="submit" disabled={saving}
            className="px-6 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 shadow-sm min-w-[100px] flex items-center justify-center">
            {saving ? <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" /> : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
