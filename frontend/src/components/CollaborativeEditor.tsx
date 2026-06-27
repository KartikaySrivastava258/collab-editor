/**
 * CollaborativeEditor — the main editing component.
 *
 * Renders a contenteditable-style textarea that integrates with the CRDT
 * engine via the useCollabEditor hook. All keyboard events are intercepted
 * and routed through the CRDT layer before updating visible text — this
 * ensures the canonical document order is always determined by fractional
 * indices, not by DOM position.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { useCollabEditor } from '../hooks/useCollabEditor';
import { ConnectionStatus, Peer } from '../types/crdt';

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface StatusBadgeProps {
  status: ConnectionStatus;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const config = {
    connecting:   { color: '#f59e0b', label: 'Connecting…',  dot: '○' },
    connected:    { color: '#10b981', label: 'Connected',     dot: '●' },
    disconnected: { color: '#6b7280', label: 'Disconnected',  dot: '○' },
    error:        { color: '#ef4444', label: 'Error',         dot: '●' },
  }[status];

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      fontSize: '13px',
      color: config.color,
      fontFamily: 'monospace',
      fontWeight: 600,
    }}>
      <span style={{ fontSize: '10px' }}>{config.dot}</span>
      {config.label}
    </span>
  );
};

interface PeerAvatarProps {
  peer: Peer;
}

const PeerAvatar: React.FC<PeerAvatarProps> = ({ peer }) => {
  const isRecent = Date.now() - peer.lastSeen < 5000;
  const label = peer.isAI ? '🤖 AI' : `👤 ${peer.clientId.slice(0, 6)}`;
  const color = peer.isAI ? '#7c3aed' : '#2563eb';

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '3px 10px',
      borderRadius: '12px',
      fontSize: '12px',
      fontWeight: 600,
      background: isRecent ? color + '20' : '#f3f4f6',
      color: isRecent ? color : '#9ca3af',
      border: `1px solid ${isRecent ? color + '40' : '#e5e7eb'}`,
      transition: 'all 0.3s ease',
    }}>
      {label}
    </span>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Editor
// ─────────────────────────────────────────────────────────────────────────────

interface CollaborativeEditorProps {
  roomId: string;
  clientId: string;
  serverURL?: string;
}

export const CollaborativeEditor: React.FC<CollaborativeEditorProps> = ({
  roomId,
  clientId,
  serverURL = 'ws://localhost:8080/ws',
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    text,
    cursorPos,
    status,
    peers,
    handleInsert,
    handleDelete,
    setCursorPos,
  } = useCollabEditor({ serverURL, roomId, clientId });

  // ── Sync cursor position to textarea ──────────────────────────────────────
  // After every text or cursor change, restore the textarea's selection.
  // This is what prevents remote mutations from "jumping" the cursor.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    // Only update the DOM if the value actually changed — prevents unnecessary
    // cursor resets when the user is mid-composition (e.g., IME input).
    if (el.value !== text) {
      el.value = text;
    }

    // Restore selection range
    const clampedCursor = Math.min(cursorPos, text.length);
    el.setSelectionRange(clampedCursor, clampedCursor);
  }, [text, cursorPos]);

  // ── Keyboard Event Handler ─────────────────────────────────────────────────

  /**
   * onKeyDown intercepts every keystroke before the browser inserts characters.
   * We preventDefault() and route through the CRDT engine instead.
   *
   * This approach (controlled keydown) vs. oninput:
   *   - Gives us precise control over cursor position at time of insertion.
   *   - Handles Backspace/Delete explicitly.
   *   - Works correctly with rapid keystrokes (no async batching issues).
   */
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = textareaRef.current;
    if (!el) return;

    // Allow copy/paste/undo shortcuts to pass through to browser
    if (e.metaKey || e.ctrlKey) return;

    // Allow navigation keys, function keys, etc.
    const ignoredKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                         'Home', 'End', 'PageUp', 'PageDown', 'Tab',
                         'Escape', 'F1', 'F2', 'Shift'];
    if (ignoredKeys.includes(e.key)) return;

    e.preventDefault(); // Suppress browser's default character insertion

    const selStart = el.selectionStart ?? cursorPos;

    if (e.key === 'Backspace') {
      if (selStart > 0) {
        // Delete character BEFORE cursor (backspace semantics)
        handleDelete(selStart);
      }
    } else if (e.key === 'Delete') {
      // Delete character AT cursor position
      if (selStart < text.length) {
        handleDelete(selStart + 1);
      }
    } else if (e.key === 'Enter') {
      handleInsert(selStart, '\n');
    } else if (e.key.length === 1) {
      // Regular printable character
      handleInsert(selStart, e.key);
    }
  }, [cursorPos, text.length, handleInsert, handleDelete]);

  /**
   * onSelectionChange tracks cursor movements that don't modify text
   * (arrow keys, click-to-position) so our state stays in sync.
   */
  const onSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (el.selectionStart === el.selectionEnd) {
      setCursorPos(el.selectionStart);
    }
  }, [setCursorPos]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const charCount = text.length;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 20px',
        background: '#ffffff',
        borderBottom: '1px solid #e5e7eb',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '16px', fontWeight: 700, color: '#111827' }}>
              Untitled Document
            </span>
            <span style={{ fontSize: '11px', color: '#9ca3af', fontFamily: 'monospace' }}>
              Room: {roomId}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Active peers */}
          {peers.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              {peers.slice(0, 5).map(peer => (
                <PeerAvatar key={peer.clientId} peer={peer} />
              ))}
            </div>
          )}
          <div style={{ width: '1px', height: '20px', background: '#e5e7eb' }} />
          <StatusBadge status={status} />
        </div>
      </div>

      {/* ── Editor area ─────────────────────────────────────────────────── */}
      <div style={{
        flex: 1,
        background: '#f9fafb',
        display: 'flex',
        justifyContent: 'center',
        padding: '40px 20px',
        overflowY: 'auto',
      }}>
        <div style={{
          width: '100%',
          maxWidth: '720px',
          background: '#ffffff',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)',
          padding: '60px 72px',
        }}>
          <textarea
            ref={textareaRef}
            defaultValue={text}
            onKeyDown={onKeyDown}
            onSelect={onSelect}
            spellCheck={true}
            placeholder="Start typing… The AI agent will join you after a 2-second pause."
            style={{
              width: '100%',
              minHeight: '480px',
              border: 'none',
              outline: 'none',
              resize: 'none',
              fontSize: '16px',
              lineHeight: '1.8',
              color: '#1f2937',
              fontFamily: '"Georgia", "Times New Roman", serif',
              background: 'transparent',
              caretColor: '#3b82f6',
            }}
          />
        </div>
      </div>

      {/* ── Status bar ──────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 20px',
        background: '#ffffff',
        borderTop: '1px solid #e5e7eb',
        fontSize: '12px',
        color: '#6b7280',
        fontFamily: 'monospace',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: '20px' }}>
          <span>{wordCount} words</span>
          <span>{charCount} characters</span>
          <span>Cursor: {cursorPos}</span>
        </div>
        <div style={{ display: 'flex', gap: '20px' }}>
          <span>{peers.length} peer{peers.length !== 1 ? 's' : ''} active</span>
          <span>Client: {clientId.slice(0, 8)}</span>
        </div>
      </div>
    </div>
  );
};
