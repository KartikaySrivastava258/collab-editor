/**
 * App.tsx — root component and room routing.
 *
 * Generates a unique clientId for this browser session and reads the
 * roomId from the URL hash (#roomId). If no hash is present, generates
 * a random room and redirects to it — enabling easy link sharing.
 */

import React, { useState, useEffect } from 'react';
import { CollaborativeEditor } from './components/CollaborativeEditor';

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Generates a random alphanumeric ID of the given length */
function randomId(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Persists clientId to sessionStorage so it survives page refreshes */
function getOrCreateClientId(): string {
  const key = 'collab_client_id';
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const newId = 'user_' + randomId(8);
  sessionStorage.setItem(key, newId);
  return newId;
}

/** Gets roomId from URL hash; creates one if absent */
function getOrCreateRoomId(): string {
  const hash = window.location.hash.slice(1);
  if (hash) return hash;
  const newRoom = 'room_' + randomId(6);
  window.location.hash = newRoom;
  return newRoom;
}

// ─────────────────────────────────────────────────────────────────────────────
// Landing screen shown before joining a room
// ─────────────────────────────────────────────────────────────────────────────

interface LandingProps {
  onJoin: (roomId: string) => void;
}

const Landing: React.FC<LandingProps> = ({ onJoin }) => {
  const [roomInput, setRoomInput] = useState('');

  const handleCreate = () => {
    const id = 'room_' + randomId(6);
    onJoin(id);
  };

  const handleJoin = () => {
    if (roomInput.trim()) onJoin(roomInput.trim());
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: 'linear-gradient(135deg, #f0f9ff 0%, #e0e7ff 100%)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{
        background: '#fff',
        borderRadius: '16px',
        padding: '48px',
        width: '400px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.1)',
      }}>
        {/* Logo / Title */}
        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <div style={{ fontSize: '40px', marginBottom: '8px' }}>✦</div>
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 800, color: '#111827' }}>
            Collab Editor
          </h1>
          <p style={{ margin: '8px 0 0', color: '#6b7280', fontSize: '14px' }}>
            Real-time collaborative editing with CRDT + AI
          </p>
        </div>

        {/* Create Room */}
        <button
          onClick={handleCreate}
          style={{
            width: '100%',
            padding: '14px',
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            fontSize: '15px',
            fontWeight: 600,
            cursor: 'pointer',
            marginBottom: '16px',
          }}
        >
          Create New Room
        </button>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <div style={{ flex: 1, height: '1px', background: '#e5e7eb' }} />
          <span style={{ color: '#9ca3af', fontSize: '13px' }}>or join existing</span>
          <div style={{ flex: 1, height: '1px', background: '#e5e7eb' }} />
        </div>

        {/* Join Room */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            value={roomInput}
            onChange={e => setRoomInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleJoin()}
            placeholder="room_abc123"
            style={{
              flex: 1,
              padding: '12px',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              fontSize: '14px',
              fontFamily: 'monospace',
              outline: 'none',
            }}
          />
          <button
            onClick={handleJoin}
            style={{
              padding: '12px 16px',
              background: '#f3f4f6',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
              color: '#374151',
            }}
          >
            Join
          </button>
        </div>

        {/* Tech callout */}
        <div style={{
          marginTop: '32px',
          padding: '12px',
          background: '#f8fafc',
          borderRadius: '8px',
          border: '1px solid #e2e8f0',
          fontSize: '12px',
          color: '#64748b',
          lineHeight: 1.5,
        }}>
          <strong>Tech Stack:</strong> Go · WebSockets · Fractional-index CRDT ·
          Lamport Timestamps · React · TypeScript · AI Agent
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// App Root
// ─────────────────────────────────────────────────────────────────────────────

const clientId = getOrCreateClientId();
const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'ws://localhost:8080/ws';

const App: React.FC = () => {
  const [roomId, setRoomId] = useState<string | null>(() => {
    const hash = window.location.hash.slice(1);
    return hash || null;
  });

  const handleJoin = (id: string) => {
    window.location.hash = id;
    setRoomId(id);
  };

  if (!roomId) {
    return <Landing onJoin={handleJoin} />;
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <CollaborativeEditor
        roomId={roomId}
        clientId={clientId}
        serverURL={SERVER_URL}
      />
    </div>
  );
};

export default App;
