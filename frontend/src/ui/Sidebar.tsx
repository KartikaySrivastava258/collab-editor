import React, { useEffect, useRef, useState } from 'react';
import { IconLogo, IconPlus, IconDoc, IconUser } from './icons.tsx';
import { parseRoomInput, relativeTime } from '../app/session.ts';
import type { RecentRoom } from '../app/session.ts';
import { sanitizeName } from '../protocol/messages.ts';

interface Props {
  open: boolean;
  activeRoom: string | null;
  recent: RecentRoom[];
  name: string;
  onNewRoom: () => void;
  onOpenRoom: (id: string) => void;
  onRename: (name: string) => void;
  onClose: () => void;
}

export function Sidebar({ open, activeRoom, recent, name, onNewRoom, onOpenRoom, onRename, onClose }: Props) {
  const [joinValue, setJoinValue] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState(name);
  const [editingName, setEditingName] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  // Drawer mode (narrow screens): move focus in on open, Escape closes from
  // anywhere, and focus returns to whatever opened the drawer.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    navRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [open, onClose]);

  const submitJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseRoomInput(joinValue);
    if (!id) {
      setJoinError('Use 1–64 letters, numbers, “-” or “_”, or paste a room link.');
      return;
    }
    setJoinError(null);
    setJoinValue('');
    onOpenRoom(id);
  };

  const submitName = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = sanitizeName(draftName);
    onRename(clean);
    setDraftName(clean);
    setEditingName(false);
  };

  return (
    <>
      <div className={`scrim ${open ? 'is-open' : ''}`} onClick={onClose} aria-hidden="true" />
      <nav ref={navRef} className={`sidebar ${open ? 'is-open' : ''}`} aria-label="Workspace" id="sidebar">
        <div className="sidebar-inner">
          <div className="brand">
            <span className="brand-mark"><IconLogo size={15} /></span>
            <span className="brand-name">Collab Editor</span>
            <span className="brand-tag">plain text</span>
          </div>

          <button className="btn btn-primary btn-block" onClick={onNewRoom} data-testid="new-room">
            <IconPlus /> New document
          </button>

          <section className="nav-section" aria-labelledby="join-label">
            <div className="nav-label" id="join-label">Join a room</div>
            <form className="join-form" onSubmit={submitJoin} noValidate>
              <label htmlFor="join-input" className="sr-only">Room ID or link</label>
              <input id="join-input" className="input" placeholder="Room ID or link" value={joinValue}
                onChange={e => { setJoinValue(e.target.value); setJoinError(null); }}
                aria-invalid={joinError ? 'true' : 'false'} aria-describedby={joinError ? 'join-error' : undefined}
                autoComplete="off" spellCheck={false} />
              <button className="btn" type="submit" disabled={!joinValue.trim()}>Join</button>
            </form>
            {joinError && <div className="field-error" id="join-error" role="alert">{joinError}</div>}
          </section>

          <section className="nav-section" aria-labelledby="recent-label">
            <div className="nav-label" id="recent-label"><span>Recent</span><span title="Stored only in this browser">this device</span></div>
            {recent.length === 0 && <div className="nav-empty">Rooms you open appear here.</div>}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
              {recent.map(r => (
                <li key={r.id}>
                  <button className="nav-item" aria-current={r.id === activeRoom ? 'page' : undefined}
                    onClick={() => onOpenRoom(r.id)} data-testid="recent-room">
                    <IconDoc /><span className="mono">{r.id}</span>
                    <span className="meta">{r.id === activeRoom ? 'open' : relativeTime(r.openedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="identity" aria-label="Your identity">
            {editingName ? (
              <form className="join-form" onSubmit={submitName}>
                <label htmlFor="name-input" className="sr-only">Display name</label>
                <input id="name-input" className="input" value={draftName} maxLength={32} autoFocus
                  onChange={e => setDraftName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setEditingName(false); setDraftName(name); } }} />
                <button className="btn" type="submit">Save</button>
              </form>
            ) : (
              <div className="identity-row">
                <IconUser />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-testid="my-name">{name}</span>
                <button className="btn btn-ghost" onClick={() => { setDraftName(name); setEditingName(true); }}>Rename</button>
              </div>
            )}
            <small>Anonymous session — no account. Anyone with a room link can read and edit it.</small>
          </section>
        </div>
      </nav>
    </>
  );
}
