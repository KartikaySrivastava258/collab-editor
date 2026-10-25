import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Sidebar } from './ui/Sidebar.tsx';
import { EditorView } from './ui/EditorView.tsx';
import { ToastProvider, ConfirmDialog } from './ui/feedback.tsx';
import type { ConfirmRequest } from './ui/feedback.tsx';
import { useSyncSession } from './ui/useSyncSession.ts';
import { IconCheck, IconPlus, IconMenu } from './ui/icons.tsx';
import {
  newClientId, newRoomId, roomFromHash, loadRecent, rememberRoom, loadName, saveName,
  loadSidebarCollapsed, saveSidebarCollapsed,
} from './app/session.ts';
import { websocketUrl } from './config.ts';

/** Routing is just the URL hash: `#<roomId>`. Old-style `#room` links keep working. */
function useHashRoom(): [string | null, (id: string | null) => void] {
  const [room, setRoom] = useState(() => roomFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoom(roomFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((id: string | null) => {
    window.location.hash = id ? encodeURIComponent(id) : '';
    setRoom(id);
  }, []);
  return [room, navigate];
}

function Landing({ onNew, onMenu }: { onNew: () => void; onMenu: () => void }) {
  return (
    <div className="main" id="main" tabIndex={-1}>
      <header className="header">
        <button className="btn btn-ghost icon-btn only-mobile" onClick={onMenu} aria-label="Open navigation"><IconMenu /></button>
        <div className="crumbs"><span className="doc-title">Workspace</span></div>
      </header>
      <div className="landing">
        <div className="landing-card">
          <h1>Write together, in real time.</h1>
          <p>Create a document and share its link. Everyone in the room edits the same plain-text document and sees changes as they happen.</p>
          <ul className="facts">
            <li><IconCheck size={16} />Concurrent edits merge automatically with a CRDT — nobody’s typing is lost.</li>
            <li><IconCheck size={16} />Works through brief disconnects: edits wait in your tab and sync when you’re back.</li>
            <li><IconCheck size={16} />No account needed. Anyone with a room link can read and edit it.</li>
            <li><IconCheck size={16} />Documents live in server memory only; they are not saved to disk.</li>
          </ul>
          <div><button className="btn btn-primary" onClick={onNew} data-testid="landing-new"><IconPlus />New document</button></div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const clientId = useMemo(newClientId, []);
  const url = useMemo(websocketUrl, []);
  const [room, navigate] = useHashRoom();
  const [name, setName] = useState(loadName);
  const [recent, setRecent] = useState(loadRecent);
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  // Record every room actually opened — including via shared links,
  // back/forward and typed URLs, not only via in-app buttons.
  useEffect(() => { if (room) setRecent(r => rememberRoom(r, room)); }, [room]);

  return (
    <ToastProvider>
      {/* Not href="#editor": the URL hash is the room route. Move focus directly. */}
      <a className="skip-link" href="#" onClick={e => {
        e.preventDefault();
        const target = document.getElementById('editor') ?? document.getElementById('main');
        target?.focus();
      }}>Skip to editor</a>
      <div className={`app ${collapsed ? 'is-collapsed' : ''}`}>
        <Shell
          room={room} clientId={clientId} url={url} name={name} recent={recent} collapsed={collapsed} menuOpen={menuOpen}
          setMenuOpen={setMenuOpen} setConfirm={setConfirm}
          onNavigate={id => { navigate(id); setMenuOpen(false); }}
          onRename={n => { setName(n); saveName(n); }}
          onToggleSidebar={() => setCollapsed(c => { saveSidebarCollapsed(!c); return !c; })}
        />
      </div>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </ToastProvider>
  );
}

interface ShellProps {
  room: string | null; clientId: string; url: string; name: string; recent: ReturnType<typeof loadRecent>;
  collapsed: boolean; menuOpen: boolean; setMenuOpen: (v: boolean) => void;
  setConfirm: (c: ConfirmRequest | null) => void;
  onNavigate: (id: string | null) => void; onRename: (n: string) => void; onToggleSidebar: () => void;
}

function Shell(p: ShellProps) {
  const { client, state } = useSyncSession(p.url, p.room ?? '', p.clientId, p.name);
  const active = p.room !== null;

  // Warn before closing the tab with edits the server has not acknowledged.
  useEffect(() => {
    if (!active || state.unsynced === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active, state.unsynced]);

  const go = (id: string) => {
    if (id === p.room) { p.setMenuOpen(false); return; }
    if (active && state.unsynced > 0) {
      p.setConfirm({
        title: 'Leave with unsynced changes?',
        body: `${state.unsynced} change${state.unsynced === 1 ? ' has' : 's have'} not reached the server yet. Leaving this room now discards ${state.unsynced === 1 ? 'it' : 'them'}.`,
        confirm: 'Leave and discard',
        onConfirm: () => p.onNavigate(id),
      });
      return;
    }
    p.onNavigate(id);
  };

  return (
    <>
      <Sidebar open={p.menuOpen} activeRoom={p.room} recent={p.recent} name={p.name}
        onNewRoom={() => go(newRoomId())} onOpenRoom={go} onRename={p.onRename} onClose={() => p.setMenuOpen(false)} />
      {active
        ? <EditorView key={p.room} roomId={p.room!} client={client} state={state}
            sidebarCollapsed={p.collapsed} onToggleSidebar={p.onToggleSidebar} onOpenMenu={() => p.setMenuOpen(true)} />
        : <Landing onNew={() => go(newRoomId())} onMenu={() => p.setMenuOpen(true)} />}
    </>
  );
}
