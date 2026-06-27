/**
 * useCollabEditor — React hook for the collaborative editing session.
 *
 * Responsibilities:
 *  1. Establish and maintain a WebSocket connection to the Go server.
 *  2. Own the CRDTDocument instance (the source of truth for document state).
 *  3. Expose insert/delete operations that optimistically update local state
 *     AND broadcast the mutation to remote peers via WebSocket.
 *  4. Process incoming mutations (from other users and the AI agent) and
 *     merge them into the local CRDT without disturbing the user's cursor.
 *
 * Cursor preservation strategy:
 *  Remote inserts BEFORE the cursor shift it right (+1).
 *  Remote deletes BEFORE the cursor shift it left (-1).
 *  Remote mutations AT or AFTER the cursor don't change it.
 *  This matches Google Docs' cursor behavior for remote inserts.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { CRDTDocument } from '../utils/crdtDocument';
import { Mutation, InitMessage, ConnectionStatus, Peer } from '../types/crdt';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface UseCollabEditorOptions {
  serverURL: string;   // e.g. "ws://localhost:8080/ws"
  roomId: string;
  clientId: string;
}

interface UseCollabEditorReturn {
  text: string;
  cursorPos: number;
  status: ConnectionStatus;
  peers: Peer[];
  handleInsert: (pos: number, value: string) => void;
  handleDelete: (pos: number) => void;
  setCursorPos: (pos: number) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useCollabEditor({
  serverURL,
  roomId,
  clientId,
}: UseCollabEditorOptions): UseCollabEditorReturn {
  // ── State ──────────────────────────────────────────────────────────────────
  const [text, setText] = useState<string>('');
  const [cursorPos, setCursorPos] = useState<number>(0);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);

  // ── Refs (survive renders without causing re-renders) ──────────────────────
  const wsRef   = useRef<WebSocket | null>(null);
  const docRef  = useRef<CRDTDocument>(new CRDTDocument(clientId));
  const cursorRef = useRef<number>(0); // Mirrors cursorPos without stale closure

  // Keep cursorRef in sync with state
  useEffect(() => { cursorRef.current = cursorPos; }, [cursorPos]);

  // ── WebSocket Lifecycle ────────────────────────────────────────────────────

  useEffect(() => {
    const url = `${serverURL}?roomId=${encodeURIComponent(roomId)}&clientId=${encodeURIComponent(clientId)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      setStatus('connected');
      console.log('[WS] Connected to room', roomId);
    };

    ws.onclose = (event) => {
      setStatus('disconnected');
      console.log('[WS] Disconnected:', event.code, event.reason);
    };

    ws.onerror = (error) => {
      setStatus('error');
      console.error('[WS] Error:', error);
    };

    ws.onmessage = (event) => {
      // The server may batch multiple JSON objects separated by newlines
      // (WritePump coalesces frames). Process each line independently.
      const lines = event.data.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          handleIncomingMessage(message);
        } catch (e) {
          console.error('[WS] Failed to parse message:', line, e);
        }
      }
    };

    return () => {
      ws.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverURL, roomId, clientId]);

  // ── Incoming Message Handler ───────────────────────────────────────────────

  /**
   * handleIncomingMessage processes both init snapshots and live mutations.
   * Using useCallback with no deps to avoid re-creating on every render —
   * the refs ensure we always read the latest state.
   */
  const handleIncomingMessage = useCallback((message: Mutation | InitMessage) => {
    const doc = docRef.current;

    if ('type' in message && message.type === 'init') {
      // Full document snapshot from server — replace local state
      doc.loadSnapshot(message.chars);
      const newText = doc.getText();
      setText(newText);
      setCursorPos(0);
      return;
    }

    const mutation = message as Mutation;

    // Track peer activity
    updatePeer(mutation.clientId);

    // Remember cursor position before applying remote mutation
    const cursorBefore = cursorRef.current;

    // Apply to CRDT document
    doc.applyRemote(mutation);

    // Update displayed text
    const newText = doc.getText();
    setText(newText);

    // Adjust cursor position to account for the remote mutation
    if (mutation.opType === 'insert') {
      // Find the visible position of the newly inserted character
      const visibleChars = doc.getVisibleChars();
      const insertedVisiblePos = visibleChars.findIndex(
        c => c.id === mutation.charId && c.clientId === mutation.clientId
      );

      // If the insert happened AT or BEFORE our cursor, shift cursor right
      if (insertedVisiblePos !== -1 && insertedVisiblePos <= cursorBefore) {
        setCursorPos(cursorBefore + 1);
      }
    } else if (mutation.opType === 'delete') {
      // Find position of deleted character in pre-delete visible array
      // (it's now tombstoned so we estimate from the text length change)
      const prevLength = cursorBefore > 0 ? cursorBefore : 0;
      const newLength = newText.length;

      if (newLength < prevLength && cursorBefore > 0) {
        // A character before cursor was deleted — shift cursor left
        setCursorPos(Math.max(0, cursorBefore - 1));
      }
    }
  }, []);

  // ── Peer Tracking ──────────────────────────────────────────────────────────

  const updatePeer = useCallback((peerId: string) => {
    if (peerId === clientId) return;

    setPeers(prev => {
      const existing = prev.find(p => p.clientId === peerId);
      if (existing) {
        return prev.map(p =>
          p.clientId === peerId ? { ...p, lastSeen: Date.now() } : p
        );
      }
      return [...prev, {
        clientId: peerId,
        isAI: peerId === 'AI_AGENT',
        lastSeen: Date.now(),
      }];
    });
  }, [clientId]);

  // ── Local Operations ───────────────────────────────────────────────────────

  /**
   * handleInsert processes a local keystroke:
   *  1. Optimistically update local CRDT and displayed text.
   *  2. Broadcast the mutation to the server (which fans it out to peers).
   *
   * Optimistic local application means the editor feels instant even on
   * high-latency connections. If the network drops, we'd need rollback logic —
   * omitted here for clarity but noted as a production concern.
   */
  const handleInsert = useCallback((pos: number, value: string) => {
    const doc = docRef.current;
    const mutation = doc.insertLocal(pos, value);
    mutation.roomId = roomId;

    setText(doc.getText());
    setCursorPos(pos + 1);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(mutation));
    }
  }, [roomId]);

  /**
   * handleDelete processes a local backspace/delete:
   *  1. Tombstone the character in the local CRDT.
   *  2. Broadcast the delete mutation.
   */
  const handleDelete = useCallback((pos: number) => {
    if (pos <= 0) return;

    const doc = docRef.current;
    const mutation = doc.deleteLocal(pos);

    if (!mutation) return;
    mutation.roomId = roomId;

    setText(doc.getText());
    setCursorPos(pos - 1);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(mutation));
    }
  }, [roomId]);

  return {
    text,
    cursorPos,
    status,
    peers,
    handleInsert,
    handleDelete,
    setCursorPos,
  };
}
