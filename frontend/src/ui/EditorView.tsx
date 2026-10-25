import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncClient, SyncState } from '../sync/SyncClient.ts';
import { EditorBinding } from '../editor/EditorBinding.ts';
import { connectionView, syncView, aiUnavailableReason } from './status.ts';
import { colorFor, countText, initials, relativeTime } from '../app/session.ts';
import { useTicker } from './useSyncSession.ts';
import { useToast } from './feedback.tsx';
import {
  IconMenu, IconSidebar, IconLink, IconUndo, IconRedo, IconCopy, IconDownload, IconSparkle,
  IconRefresh, IconCheck, IconAlert, IconServer, IconX,
} from './icons.tsx';

interface Props {
  roomId: string;
  client: SyncClient | null;
  state: SyncState;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenMenu: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

export function EditorView({ roomId, client, state, sidebarCollapsed, onToggleSidebar, onOpenMenu }: Props) {
  const toast = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bindingRef = useRef<EditorBinding | null>(null);
  const [, force] = useState(0);
  const [stats, setStats] = useState({ words: 0, chars: 0 });
  const now = useTicker(state.retryAt !== null || state.lastRemoteEditAt !== null);

  // Bind the uncontrolled textarea to the session.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || !client) return;
    // Word counts are O(n); recompute after a short pause, not on every keystroke (profiled hot spot).
    let statsTimer: ReturnType<typeof setTimeout> | null = null;
    const b = new EditorBinding(el, client, {
      onRejected: reason => toast('error', reason),
      onChange: () => {
        force(x => x + 1);
        if (statsTimer === null) statsTimer = setTimeout(() => { statsTimer = null; setStats(countText(b.text)); }, 150);
      },
    });
    bindingRef.current = b;
    (window as unknown as { __collabBinding?: EditorBinding }).__collabBinding = b; // test/diagnostic hook
    setStats(countText(b.text));
    return () => { if (statsTimer) clearTimeout(statsTimer); b.destroy(); bindingRef.current = null; };
  }, [client, toast]);

  // Surface client notices (e.g. rolled-back edits) once.
  useEffect(() => {
    if (state.notice && client) {
      toast(state.notice.kind === 'error' ? 'error' : 'info', state.notice.text);
      client.clearNotice();
    }
  }, [state.notice, client, toast]);

  // Announce recovery after an outage.
  const wasDown = useRef(false);
  useEffect(() => {
    if (state.phase === 'connected' && wasDown.current) toast('success', 'Reconnected — document re-synchronised.');
    wasDown.current = state.joined && state.phase !== 'connected';
  }, [state.phase, state.joined, toast]);

  const conn = connectionView(state, now);
  const sync = syncView(state);
  const aiBlocked = aiUnavailableReason(state);
  const binding = bindingRef.current;
  const canUndo = !!binding?.history.canUndo && state.phase !== 'replaced';
  const canRedo = !!binding?.history.canRedo && state.phase !== 'replaced';
  const firstLoad = !state.joined && state.attempt === 0 && state.phase === 'connecting';
  const others = state.peers.filter(p => p.id !== client?.clientId);
  const showBanner = state.phase === 'reconnecting' || state.phase === 'offline' || (state.phase === 'connecting' && state.attempt > 0);

  const shareLink = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(roomId)}`;
  const copy = useCallback(async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('success', okMsg);
    } catch {
      toast('error', 'Clipboard access was blocked by the browser. Select and copy manually.');
    }
  }, [toast]);

  const download = () => {
    const blob = new Blob([binding?.text ?? ''], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${roomId}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const ai = state.aiRequest;
  const aiStale = ai.status === 'ready' && ai.docVersion !== state.version;

  return (
    <div className="main" id="main" tabIndex={-1}>
      <header className="header">
        <button className="btn btn-ghost icon-btn only-mobile" onClick={onOpenMenu} aria-label="Open navigation" aria-controls="sidebar"><IconMenu /></button>
        <button className="btn btn-ghost icon-btn only-desktop" onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-pressed={!sidebarCollapsed}
          data-tip={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}><IconSidebar /></button>
        <div className="crumbs">
          <span className="crumb-path">Workspace / Rooms</span>
          <h1 className="doc-title" style={{ margin: 0 }}>Room <span className="mono" data-testid="room-id">{roomId}</span></h1>
        </div>
        <div className="header-right">
          <span className={`pill ${conn.tone} ${conn.busy ? 'busy' : ''}`} title={conn.detail} data-testid="connection" role="status" aria-label={`Connection: ${conn.label}. ${conn.detail}`}>
            <span className="dot" />{conn.label}
          </span>
          {state.peers.length > 0 && (
            <div className="avatars hide-narrow" aria-label={`${state.peers.length} connected: ${state.peers.map(p => (p.id === client?.clientId ? `${p.name} (you)` : p.name)).join(', ')}`} data-testid="presence" role="img">
              {[...others, ...state.peers.filter(p => p.id === client?.clientId)].slice(0, 4).map(p => (
                <span key={p.id} className="avatar" style={{ background: colorFor(p.id) }} title={p.id === client?.clientId ? `${p.name} (you)` : p.name}>{initials(p.name)}</span>
              ))}
              {state.peers.length > 4 && <span className="avatar more">+{state.peers.length - 4}</span>}
            </div>
          )}
          <button className="btn" onClick={() => copy(shareLink, 'Room link copied. Anyone with it can edit.')} data-tip="Copy a link to this room" data-tip-pos="left" data-testid="share">
            <IconLink /><span className="hide-narrow">Share</span>
          </button>
        </div>
      </header>

      {showBanner && (
        <div className={`banner ${state.phase === 'offline' ? 'bad' : 'warn'}`} role="alert" data-testid="offline-banner">
          <IconAlert />
          <span className="banner-text">
            <strong>{conn.label}</strong> {conn.detail}
            {state.unsynced > 0 && ` Your ${state.unsynced} unsynced change${state.unsynced === 1 ? ' is' : 's are'} kept in this tab and will be sent automatically.`}
          </span>
          <button className="btn" onClick={() => client?.retryNow()}><IconRefresh size={14} />Retry now</button>
        </div>
      )}
      {state.phase === 'replaced' && (
        <div className="banner bad" role="alert">
          <IconAlert /><span className="banner-text">{conn.detail}</span>
          <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}

      <div className="toolbar" role="toolbar" aria-label="Editor actions">
        <div className="toolbar-group">
          <button className="btn btn-ghost icon-btn" onClick={() => binding?.undo()} disabled={!canUndo} aria-label="Undo" data-tip={`Undo your last edit (${MOD}Z)`} aria-keyshortcuts="Control+Z Meta+Z"><IconUndo /></button>
          <button className="btn btn-ghost icon-btn" onClick={() => binding?.redo()} disabled={!canRedo} aria-label="Redo" data-tip={`Redo (${MOD}Shift+Z)`} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"><IconRedo /></button>
        </div>
        <span className="toolbar-sep" aria-hidden="true" />
        <div className="toolbar-group">
          <button className="btn btn-ghost icon-btn" onClick={() => copy(binding?.text ?? '', 'Document text copied.')} disabled={!binding} aria-label="Copy document text" data-tip="Copy all text"><IconCopy /></button>
          <button className="btn btn-ghost icon-btn" onClick={download} disabled={!binding} aria-label="Download as .txt" data-tip="Download as .txt"><IconDownload /></button>
        </div>
        <span className="toolbar-spacer" />
        <span className="toolbar-note hide-narrow">Plain text · edits are shared live</span>
        <span className="toolbar-sep hide-narrow" aria-hidden="true" />
        <button className="btn" onClick={() => client?.requestSuggestion()} disabled={!!aiBlocked || ai.status === 'thinking'}
          aria-describedby="ai-reason" data-tip={aiBlocked ?? 'Ask AI to suggest a continuation'} data-tip-pos="left" data-testid="ai-suggest">
          <IconSparkle />Suggest
        </button>
        <span id="ai-reason" className="sr-only">{aiBlocked ?? 'Generates a suggestion only you can see; nothing is inserted until you choose.'}</span>
      </div>

      <div className="canvas">
        <div className="page">
          {firstLoad && (
            <div className="skeleton" aria-busy="true" aria-label="Loading document" data-testid="skeleton">
              <span style={{ width: '62%' }} /><span style={{ width: '88%' }} /><span style={{ width: '76%' }} /><span style={{ width: '40%' }} />
            </div>
          )}
          <label htmlFor="editor" className="sr-only">Document text for room {roomId}</label>
          <textarea id="editor" ref={textareaRef} className="editor" data-testid="editor"
            hidden={firstLoad} readOnly={state.phase === 'replaced'} spellCheck
            placeholder={'Start writing…\n\nEverything you type is shared live with everyone who has this room’s link.'} />
        </div>
      </div>

      {ai.status !== 'idle' && (
        <section className="ai-panel" aria-live="polite" aria-label="AI suggestion" data-testid="ai-panel">
          {ai.status === 'thinking' && (<>
            <header><IconSparkle />Generating a suggestion…</header>
            <div className="actions"><button className="btn" onClick={() => client?.cancelSuggestion()}>Cancel</button></div>
          </>)}
          {ai.status === 'ready' && (<>
            <header><IconSparkle />Suggestion <span className="note">— only visible to you</span></header>
            <p data-testid="ai-text">{ai.text}</p>
            {aiStale && <div className="note">The document changed since this was requested.</div>}
            <div className="actions">
              <button className="btn btn-primary" onClick={() => {
                bindingRef.current?.replaceSelection(ai.text);
                client?.dismissSuggestion();
                toast('success', `Suggestion inserted. Undo with ${MOD}Z.`);
              }}>Insert at cursor</button>
              <button className="btn" onClick={() => client?.dismissSuggestion()}>Discard</button>
            </div>
          </>)}
          {ai.status === 'error' && (<>
            <header><IconAlert />Suggestion failed</header>
            <div className="note">{ai.message}</div>
            <div className="actions"><button className="btn" onClick={() => client?.dismissSuggestion()}><IconX size={14} />Dismiss</button></div>
          </>)}
          {ai.status === 'cancelled' && (<>
            <header>Suggestion cancelled</header>
            <div className="actions"><button className="btn" onClick={() => client?.dismissSuggestion()}>Dismiss</button></div>
          </>)}
        </section>
      )}

      <footer className="statusbar">
        <span className={`status-sync pill ${sync.tone}`} style={{ height: 20 }} data-testid="sync-status">
          {sync.tone === 'ok' ? <IconCheck size={12} /> : <IconAlert size={12} />}{sync.text}
        </span>
        <span className="hide-narrow" title="Rooms are kept in server memory only. If the server restarts, a connected client restores the room from its copy; otherwise the content is lost.">
          <IconServer size={12} /> Memory-only storage
        </span>
        <div className="right">
          {state.lastRemoteEditAt !== null && <span className="hide-narrow">Last remote edit {relativeTime(state.lastRemoteEditAt, now)}</span>}
          <span data-testid="stats">{stats.words.toLocaleString()} words · {stats.chars.toLocaleString()} characters</span>
          <span>{state.peers.length} online</span>
        </div>
      </footer>
    </div>
  );
}
