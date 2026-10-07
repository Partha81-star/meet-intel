'use client';
import { useState } from 'react';
import { CheckSquare, Square, Trash2, ListTodo, CalendarDays } from 'lucide-react';
export default function ActionItemsPanel({ items, setItems, onToggle, onRemove }) {
  const [filter, setFilter] = useState('all');
  const pending = items.filter(item => !item.done).length;
  const visible = items.filter(item => filter === 'all' || (filter === 'done' ? item.done : !item.done));
  const toggle = id => onToggle ? onToggle(id) : setItems(previous => previous.map(item => item.id === id ? { ...item, done: !item.done } : item));
  const remove = id => onRemove ? onRemove(id) : setItems(previous => previous.filter(item => item.id !== id));
  return <>
    <div className="card-heading"><div><h2>Action items <span className="heading-count">{items.length}</span></h2><p>{pending} open · {items.length - pending} completed</p></div><ListTodo size={20} /></div>
    <div className="filter-bar" aria-label="Filter action items">{['all', 'pending', 'done'].map(value => <button key={value} className={`filter-button ${filter === value ? 'selected' : ''}`} onClick={() => setFilter(value)}>{value === 'all' ? 'All items' : value === 'done' ? 'Completed' : 'Open'}</button>)}</div>
    {!visible.length ? <div className="empty-state"><CheckSquare size={28} /><h3>{items.length ? 'No items in this view' : 'No action items yet'}</h3><p>{items.length ? 'Choose another filter to see your tasks.' : 'Assignments from your meeting will appear here with an owner and due date.'}</p></div> : <div className="task-list">{visible.map(item => <article key={item.id} className={`task-row ${item.done ? 'task-completed' : ''}`}>
      <button className="icon-button task-checkbox" aria-label={item.done ? 'Mark incomplete' : 'Mark complete'} onClick={() => toggle(item.id)}>{item.done ? <CheckSquare size={19} /> : <Square size={19} />}</button>
      <div className="task-content"><h3>{item.title}</h3><div className="task-meta"><span className="person-label"><span className="avatar avatar-small">{(item.assignee || 'U').split(' ').map(word => word[0]).join('').slice(0, 2)}</span>{item.assignee || 'Unassigned'}</span>{item.due && <span><CalendarDays size={13} />{item.due}</span>}<span className={`priority priority-${item.priority || 'medium'}`}>{item.priority || 'medium'} priority</span></div>{item.context && <p className="task-context">{item.context}</p>}</div>
      <button className="icon-button" aria-label="Remove task" onClick={() => remove(item.id)}><Trash2 size={16} /></button>
    </article>)}</div>}
  </>;
}
