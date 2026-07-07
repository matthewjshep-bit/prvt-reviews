import React, { useState, useEffect, useRef } from 'react';
import { X, Search, Phone, Mail, Trash2, UserPlus, Link as LinkIcon, Plus, Check, Circle, Tag, StickyNote, ListTodo, ExternalLink, MessageSquare } from 'lucide-react';
import { 
  updateOpportunity, createOpportunity, searchContacts, 
  getLinkedContacts, addLinkedContact, removeLinkedContact,
  fetchContactNotes, createNote,
  fetchContactTasks, createTask, toggleTask,
  fetchContactTags, addTag, deleteTag,
  fetchContactOpportunities, fetchContactMessages
} from './api';

const TAG_COLORS = [
  'bg-blue-100 text-blue-700', 'bg-emerald-100 text-emerald-700', 'bg-purple-100 text-purple-700',
  'bg-amber-100 text-amber-700', 'bg-rose-100 text-rose-700', 'bg-cyan-100 text-cyan-700',
  'bg-orange-100 text-orange-700', 'bg-indigo-100 text-indigo-700'
];

export default function Drawer({ open, onClose, card, stages, onSave }) {
  const isCreateMode = card && !card.id;
  const messagesEndRef = useRef(null);
  
  const [name, setName] = useState('');
  const [stageId, setStageId] = useState('');
  const [monetaryValue, setMonetaryValue] = useState('');
  
  const [primaryContactId, setPrimaryContactId] = useState('');
  const [primaryContactName, setPrimaryContactName] = useState('');
  
  const [linkedContacts, setLinkedContacts] = useState([]);
  const [contactSearch, setContactSearch] = useState('');
  const [contactResults, setContactResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  
  // Activity
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
  const [messages, setMessages] = useState([]);
  
  // Tabs for center column
  const [activeTab, setActiveTab] = useState('messages');
  
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const locationId = new URLSearchParams(window.location.search).get("locationId");
  const getContactUrl = (cid) => `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${cid}`;

  useEffect(() => {
    if (!open || !card) return;
    if (card.id) getLinkedContacts(card.id).then(setLinkedContacts).catch(console.error);
    const cid = card.contact?.id || card.contactId;
    if (cid) {
      fetchContactNotes(cid).then(setContactNotes).catch(console.error);
      fetchContactTasks(cid).then(setContactTasks).catch(console.error);
      fetchContactTags(cid).then(setTags).catch(console.error);
      fetchContactOpportunities(cid).then(opps => setRelatedOpps(opps.filter(o => o.id !== card.id))).catch(console.error);
      fetchContactMessages(cid).then(msgs => { setMessages(msgs); setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100); }).catch(console.error);
    }
  }, [open, card]);

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
      setName(card.name || ''); setStageId(card.stageId || ''); setMonetaryValue(card.monetaryValue || 0);
      if (card.contact) { setPrimaryContactId(card.contact.id || ''); setPrimaryContactName(card.contact.name || ''); }
      else { setPrimaryContactId(''); setPrimaryContactName(''); }
      setContactSearch(''); setContactResults([]); setError(null);
      setContactNotes([]); setContactTasks([]); setTags([]); setRelatedOpps([]); setLinkedContacts([]); setMessages([]);
      setActiveTab('messages');
    }
  }, [card]);

  if (!open || !card) return null;
  const activeContactId = primaryContactId || card?.contact?.id;

  const handleSubmit = async (e) => {
    e.preventDefault(); setSaving(true); setError(null);
    try {
      const payload = { name, stageId, monetaryValue: parseFloat(monetaryValue) || 0 };
      let updated;
      if (isCreateMode) {
        if (!primaryContactId) throw new Error("Please select a primary contact.");
        payload.contactId = primaryContactId;
        updated = await createOpportunity(payload);
        for (const c of linkedContacts) {
          await addLinkedContact(updated.id, { id: c.contact_id, name: c.contact_name, email: c.contact_email, phone: c.contact_phone }, name);
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
        await addLinkedContact(card.id, contact, card.name || name);
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
    try { const note = await createNote(activeContactId, { body: newNoteText.trim() }); setContactNotes([note, ...contactNotes]); setNewNoteText(''); }
    catch (err) { setError(err.message); } finally { setAddingNote(false); }
  };

  const handleAddTask = async () => {
    if (!newTaskTitle.trim() || !activeContactId) return;
    setAddingTask(true);
    try { const task = await createTask(activeContactId, { title: newTaskTitle.trim(), dueDate: newTaskDue || undefined }); setContactTasks([task, ...contactTasks]); setNewTaskTitle(''); setNewTaskDue(''); }
    catch (err) { setError(err.message); } finally { setAddingTask(false); }
  };

  const handleToggleTask = async (task) => {
    if (!activeContactId) return;
    try { await toggleTask(activeContactId, task.id, { completed: !task.completed }); setContactTasks(contactTasks.map(t => t.id === task.id ? { ...t, completed: !task.completed } : t)); }
    catch (err) { setError(err.message); }
  };

  const handleAddTag = async () => {
    if (!newTagText.trim() || !activeContactId) return;
    setAddingTag(true);
    try { await addTag(activeContactId, [newTagText.trim()]); setTags([...tags, newTagText.trim()]); setNewTagText(''); }
    catch (err) { setError(err.message); } finally { setAddingTag(false); }
  };

  const handleRemoveTag = async (tagName) => {
    if (!activeContactId) return;
    try { await deleteTag(activeContactId, [tagName]); setTags(tags.filter(t => t !== tagName)); }
    catch (err) { setError(err.message); }
  };

  const tabs = [
    { id: 'messages', label: 'Messages', icon: MessageSquare, count: messages.length },
    { id: 'notes', label: 'Notes', icon: StickyNote, count: contactNotes.length },
    { id: 'tasks', label: 'Tasks', icon: ListTodo, count: contactTasks.length },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative bg-white rounded-2xl shadow-2xl w-[96vw] h-[94vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-gray-100 bg-gray-50/50 shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-bold text-gray-900">{isCreateMode ? 'Create New Opportunity' : card.name || 'Opportunity Details'}</h2>
            {/* Tags inline */}
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag, i) => (
                <span key={tag} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${TAG_COLORS[i % TAG_COLORS.length]}`}>
                  {tag}
                  {!isCreateMode && <button type="button" onClick={() => handleRemoveTag(tag)} className="hover:opacity-70">&times;</button>}
                </span>
              ))}
              {!isCreateMode && activeContactId && (
                <div className="flex items-center gap-1">
                  <input type="text" value={newTagText} onChange={(e) => setNewTagText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTag())}
                    placeholder="+ tag" className="border-0 bg-transparent text-xs text-gray-400 focus:outline-none w-16 placeholder:text-gray-300" />
                </div>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          <form id="opp-form" onSubmit={handleSubmit} className="flex-1 flex min-h-0">
            
            {/* === LEFT: Opportunity Details === */}
            <div className="w-[280px] shrink-0 p-5 space-y-4 border-r border-gray-100 overflow-y-auto">
              {error && <div className="p-2.5 text-xs text-red-600 bg-red-50 border border-red-100 rounded-xl">{error}</div>}
              
              <div>
                <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Opportunity Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 shadow-sm" placeholder="e.g. John Doe Reactivation" required />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Pipeline Stage</label>
                <select value={stageId} onChange={(e) => setStageId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 shadow-sm">
                  {stages.map(s => <option key={s.stageId} value={s.stageId}>{s.stageName}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Monetary Value</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><span className="text-gray-500 text-sm">$</span></div>
                  <input type="number" step="0.01" value={monetaryValue} onChange={(e) => setMonetaryValue(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 shadow-sm" />
                </div>
              </div>

              {/* Related Opps */}
              {!isCreateMode && relatedOpps.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                    <ExternalLink className="w-3 h-3" /> Related Opps
                  </h3>
                  <div className="space-y-1.5">
                    {relatedOpps.map(opp => (
                      <div key={opp.id} className="bg-gray-50 border border-gray-100 rounded-lg p-2.5">
                        <div className="font-medium text-xs text-gray-900">{opp.name}</div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-[10px] text-gray-500 capitalize">{opp.status}</span>
                          {opp.monetaryValue > 0 && <span className="text-[11px] font-semibold text-emerald-600">${opp.monetaryValue.toLocaleString()}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* === CENTER: Activity (Messages, Notes, Tasks) === */}
            <div className="flex-1 flex flex-col min-h-0">
              {/* Tab Bar */}
              <div className="shrink-0 flex border-b border-gray-100 px-4">
                {tabs.map(tab => (
                  <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                      activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                    <tab.icon className="w-3.5 h-3.5" />
                    {tab.label}
                    {tab.count > 0 && <span className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full text-[10px]">{tab.count}</span>}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div className="flex-1 overflow-y-auto p-4">
                
                {/* Messages Tab */}
                {activeTab === 'messages' && (
                  <div className="space-y-3">
                    {messages.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No messages found for this contact.</p>}
                    {messages.map((msg, i) => (
                      <div key={msg.id || i} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
                          msg.direction === 'outbound' 
                            ? 'bg-blue-600 text-white rounded-br-md' 
                            : 'bg-gray-100 text-gray-900 rounded-bl-md'
                        }`}>
                          <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                          <p className={`text-[10px] mt-1 ${msg.direction === 'outbound' ? 'text-blue-200' : 'text-gray-400'}`}>
                            {msg.dateAdded ? new Date(msg.dateAdded).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                            {msg.type && msg.type !== 'SMS' && ` · ${msg.type}`}
                          </p>
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                )}

                {/* Notes Tab */}
                {activeTab === 'notes' && (
                  <div>
                    {!isCreateMode && activeContactId && (
                      <div className="flex gap-2 mb-4">
                        <input type="text" value={newNoteText} onChange={(e) => setNewNoteText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddNote())}
                          placeholder="Write a note..." className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
                        <button type="button" onClick={handleAddNote} disabled={addingNote || !newNoteText.trim()}
                          className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-40"><Plus className="w-4 h-4" /></button>
                      </div>
                    )}
                    <div className="space-y-2">
                      {contactNotes.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No notes yet.</p>}
                      {contactNotes.map((note, i) => (
                        <div key={note.id || i} className="bg-gray-50 rounded-xl p-4 border border-gray-100">
                          <p className="text-sm text-gray-800 whitespace-pre-wrap">{note.body}</p>
                          <p className="text-[10px] text-gray-400 mt-2">{note.dateAdded ? new Date(note.dateAdded).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tasks Tab */}
                {activeTab === 'tasks' && (
                  <div>
                    {!isCreateMode && activeContactId && (
                      <div className="flex gap-2 mb-4">
                        <input type="text" value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTask())}
                          placeholder="New task..." className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
                        <input type="date" value={newTaskDue} onChange={(e) => setNewTaskDue(e.target.value)}
                          className="border border-gray-200 rounded-lg px-2 py-2 text-xs text-gray-600 focus:ring-2 focus:ring-blue-500 w-[130px]" />
                        <button type="button" onClick={handleAddTask} disabled={addingTask || !newTaskTitle.trim()}
                          className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-40"><Plus className="w-4 h-4" /></button>
                      </div>
                    )}
                    <div className="space-y-2">
                      {contactTasks.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No tasks yet.</p>}
                      {contactTasks.map((task, i) => (
                        <div key={task.id || i} className="flex items-start gap-3 p-3 rounded-xl hover:bg-gray-50 group">
                          <button type="button" onClick={() => handleToggleTask(task)} className="mt-0.5 shrink-0">
                            {task.completed ? <Check className="w-5 h-5 text-emerald-500" /> : <Circle className="w-5 h-5 text-gray-300 group-hover:text-gray-400" />}
                          </button>
                          <div className="flex-1">
                            <p className={`text-sm ${task.completed ? 'line-through text-gray-400' : 'text-gray-800'}`}>{task.title || task.body}</p>
                            {task.dueDate && <p className="text-[11px] text-gray-400 mt-0.5">{new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </form>

          {/* === RIGHT: Contacts === */}
          <div className="w-[260px] shrink-0 border-l border-gray-100 p-4 overflow-y-auto space-y-4">
            <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <UserPlus className="w-3.5 h-3.5" /> Linked Contacts
            </h3>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none"><Search className="h-3.5 w-3.5 text-gray-400" /></div>
              <input type="text" value={contactSearch} onChange={(e) => setContactSearch(e.target.value)}
                placeholder="Search CRM..." className="w-full border border-gray-200 rounded-lg pl-8 pr-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 bg-gray-50" />
              {isSearching && <div className="absolute inset-y-0 right-0 pr-3 flex items-center"><div className="animate-spin h-3.5 w-3.5 border-2 border-blue-600 border-t-transparent rounded-full"></div></div>}
              {contactResults.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl max-h-48 overflow-auto">
                  {contactResults.map(c => (
                    <button key={c.id} type="button" onClick={() => handleLinkContact(c)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-0">
                      <div className="font-medium text-xs text-gray-900">{c.name}</div>
                      <div className="text-[10px] text-gray-500">{c.email}</div>
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
                    className="font-semibold text-xs text-gray-900 hover:text-blue-600">{primaryContactName || card?.contact?.name}</a>
                  {card?.contact?.phone && <a href={`tel:${card.contact.phone}`} className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-blue-600 mt-1.5"><Phone className="w-3 h-3" />{card.contact.phone}</a>}
                  {card?.contact?.email && <a href={`mailto:${card.contact.email}`} className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-blue-600 mt-1"><Mail className="w-3 h-3" />{card.contact.email}</a>}
                </div>
              )}

              {linkedContacts.map(c => (
                <div key={c.contact_id} className="bg-white border border-gray-200 rounded-xl p-3 relative group hover:border-gray-300">
                  <div className="absolute top-0 right-0 px-1.5 py-0.5 bg-gray-100 text-gray-500 text-[9px] font-bold uppercase rounded-bl-lg rounded-tr-xl flex items-center gap-0.5"><LinkIcon className="w-2.5 h-2.5" /> Linked</div>
                  <a href={getContactUrl(c.contact_id)} target="_blank" rel="noreferrer"
                    className="font-semibold text-xs text-gray-900 hover:text-blue-600">{c.contact_name}</a>
                  {c.contact_phone && <a href={`tel:${c.contact_phone}`} className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-blue-600 mt-1.5"><Phone className="w-3 h-3" />{c.contact_phone}</a>}
                  {c.contact_email && <a href={`mailto:${c.contact_email}`} className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-blue-600 mt-1"><Mail className="w-3 h-3" />{c.contact_email}</a>}
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
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-3 bg-gray-50/50 shrink-0">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100 rounded-xl">Cancel</button>
          <button form="opp-form" type="submit" disabled={saving}
            className="px-5 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 shadow-sm min-w-[100px] flex items-center justify-center">
            {saving ? <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" /> : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
