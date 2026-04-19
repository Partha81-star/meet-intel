'use client';

/**
 * ActionItemsPanel.jsx — Participant-Grouped Task Dashboard
 *
 * Uses inline styles for colors instead of dynamic Tailwind classes,
 * which are not safe to use with runtime-assembled class strings.
 */

import { useState, useMemo } from 'react';
import { CheckSquare, Square, Trash2, Clock, AlertCircle } from 'lucide-react';

// ── Fixed colour palette per index — pre-defined so Tailwind doesn't need to purge ─────
const PALETTE = [
  { bg: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.40)', textColor: '#c4b5fd', avatarBg: '#8b5cf6' },
  { bg: 'rgba(6,182,212,0.12)',  border: '1px solid rgba(6,182,212,0.40)',  textColor: '#67e8f9', avatarBg: '#06b6d4' },
  { bg: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.40)',  textColor: '#fda4af', avatarBg: '#f43f5e' },
  { bg: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.40)', textColor: '#fcd34d', avatarBg: '#f59e0b' },
  { bg: 'rgba(34,197,94,0.12)',  border: '1px solid rgba(34,197,94,0.40)',  textColor: '#86efac', avatarBg: '#22c55e' },
];

const PRIORITY_STYLE = {
  high:   { color: '#fca5a5', bg: 'rgba(239,68,68,0.15)',  borderLeft: '2px solid #ef4444' },
  medium: { color: '#fcd34d', bg: 'rgba(245,158,11,0.12)', borderLeft: '2px solid #f59e0b' },
  low:    { color: '#c4b5fd', bg: 'rgba(139,92,246,0.10)', borderLeft: '2px solid #8b5cf6' },
};

function getInitials(name = '') {
  return name.split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
}

// ── Single task card ──────────────────────────────────────────────────────────
function TaskCard({ item, onToggle, onRemove }) {
  const pStyle = PRIORITY_STYLE[item.priority || 'medium'] || PRIORITY_STYLE.medium;

  return (
    <div
      style={{
        background:   pStyle.bg,
        borderLeft:   pStyle.borderLeft,
        borderRadius: '0 8px 8px 0',
        padding:      '10px 12px',
        marginBottom: '8px',
        display:      'flex',
        alignItems:   'flex-start',
        gap:          '10px',
        opacity:      item.done ? 0.45 : 1,
        transition:   'opacity 0.2s',
      }}
    >
      {/* Checkbox */}
      <button
        onClick={() => onToggle(item.id)}
        style={{ marginTop: 2, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer' }}
        aria-label={item.done ? 'Mark incomplete' : 'Mark complete'}
      >
        {item.done
          ? <CheckSquare size={15} color="#4ade80" />
          : <Square      size={15} color="rgba(255,255,255,0.3)" />
        }
      </button>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize:       13,
          fontWeight:     600,
          color:          item.done ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.9)',
          textDecoration: item.done ? 'line-through' : 'none',
          margin:         0,
          lineHeight:     1.4,
        }}>
          {item.title}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
          <span style={{
            fontSize:   9,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color:    pStyle.color,
            background: 'rgba(255,255,255,0.06)',
            padding:  '1px 6px',
            borderRadius: 4,
          }}>
            {item.priority || 'medium'}
          </span>
          {item.due && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
              <Clock size={10} /> {item.due}
            </span>
          )}
        </div>
        {item.context && (
          <p style={{
            fontSize:    10,
            color:       'rgba(255,255,255,0.25)',
            fontStyle:   'italic',
            margin:      '5px 0 0',
            lineHeight:  1.5,
            overflow:    'hidden',
            display:     '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}>
            "{item.context}"
          </p>
        )}
      </div>

      {/* Delete */}
      <button
        onClick={() => onRemove(item.id)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, marginTop: 2, opacity: 0.4 }}
        onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.querySelector('svg').style.color = '#f87171'; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = '0.4'; e.currentTarget.querySelector('svg').style.color = 'rgba(255,255,255,0.3)'; }}
        aria-label="Remove task"
      >
        <Trash2 size={13} color="rgba(255,255,255,0.3)" />
      </button>
    </div>
  );
}

// ── One swimlane per person ──────────────────────────────────────────────────
function AssigneeLane({ name, items, palette, onToggle, onRemove }) {
  const [collapsed, setCollapsed] = useState(false);
  const pending = items.filter(i => !i.done).length;

  return (
    <div style={{
      borderRadius: 12,
      border:       palette.border,
      background:   palette.bg,
      overflow:     'hidden',
      marginBottom: 12,
    }}>
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        style={{
          width:      '100%',
          display:    'flex',
          alignItems: 'center',
          gap:        12,
          padding:    '10px 14px',
          background: 'none',
          border:     'none',
          cursor:     'pointer',
          textAlign:  'left',
        }}
      >
        {/* Avatar */}
        <div style={{
          width:          32,
          height:         32,
          borderRadius:   '50%',
          background:     palette.avatarBg,
          color:          '#fff',
          fontWeight:     700,
          fontSize:       12,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          flexShrink:     0,
        }}>
          {getInitials(name)}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: palette.textColor }}>{name}</p>
          <p style={{ margin: 0, fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
            {pending} pending · {items.length} total
          </p>
        </div>

        {pending > 0 && (
          <span style={{
            background:   palette.avatarBg,
            color:        '#fff',
            fontSize:     10,
            fontWeight:   700,
            padding:      '2px 8px',
            borderRadius: 99,
          }}>
            {pending}
          </span>
        )}

        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10, transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform 0.2s' }}>▶</span>
      </button>

      {/* Tasks */}
      {!collapsed && (
        <div style={{ padding: '0 12px 12px' }}>
          {items.map(item => (
            <TaskCard key={item.id} item={item} onToggle={onToggle} onRemove={onRemove} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ───────────────────────────────────────────────────────────────
export default function ActionItemsPanel({ items, setItems }) {
  const [filter, setFilter] = useState('all');

  // Stable color assignment map
  const colorIndexMap = useMemo(() => ({}), []);
  function getPalette(name) {
    if (!(name in colorIndexMap)) {
      colorIndexMap[name] = Object.keys(colorIndexMap).length % PALETTE.length;
    }
    return PALETTE[colorIndexMap[name]];
  }

  const toggleDone = id => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, done: !i.done, isNew: false } : i));
  };

  const removeItem = id => {
    setItems(prev => prev.filter(i => i.id !== id));
  };

  const filtered = items.filter(item => {
    if (filter === 'pending') return !item.done;
    if (filter === 'done')    return  item.done;
    return true;
  });

  const groups = useMemo(() => {
    const map = {};
    for (const item of filtered) {
      const key = item.assignee || 'Unassigned';
      if (!map[key]) map[key] = [];
      map[key].push(item);
    }
    return map;
  }, [filtered]);

  const pendingCount = items.filter(i => !i.done).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16, gap: 12 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CheckSquare size={15} color="#4ade80" />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>Action Items</span>
          {pendingCount > 0 && (
            <span style={{
              padding:      '1px 7px',
              borderRadius: 99,
              fontSize:     10,
              fontWeight:   700,
              background:   'rgba(74,222,128,0.15)',
              color:        '#4ade80',
            }}>
              {pendingCount} open
            </span>
          )}
        </div>

        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 4 }}>
          {['all', 'pending', 'done'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding:     '2px 8px',
                borderRadius: 6,
                fontSize:    10,
                fontWeight:  600,
                border:      'none',
                cursor:      'pointer',
                background:  filter === f ? 'rgba(139,92,246,0.25)' : 'transparent',
                color:       filter === f ? '#c4b5fd' : 'rgba(255,255,255,0.35)',
                transition:  'all 0.15s',
              }}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Swimlanes */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 160, textAlign: 'center' }}>
            <AlertCircle size={32} color="rgba(255,255,255,0.12)" />
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', margin: '8px 0 4px' }}>
              {items.length === 0 ? 'AI will detect task assignments as you speak' : 'No items match the current filter'}
            </p>
            {items.length === 0 && (
              <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.18)', margin: 0 }}>
                Try: "Parth, please update the API docs by Friday"
              </p>
            )}
          </div>
        ) : (
          Object.keys(groups).map(name => (
            <AssigneeLane
              key={name}
              name={name}
              items={groups[name]}
              palette={getPalette(name)}
              onToggle={toggleDone}
              onRemove={removeItem}
            />
          ))
        )}
      </div>
    </div>
  );
}
