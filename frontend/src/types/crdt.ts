/**
 * Core CRDT types — mirrors the Go backend's data structures.
 * These types define the wire protocol between client and server.
 */

/**
 * Char is an immutable atom in the collaborative document.
 * Once created on any replica, its ID and clientId never change.
 */
export interface Char {
  /** Fractional index in [0, 1] defining absolute document position */
  id: number;
  /** Single UTF-8 character */
  value: string;
  /** Lamport logical timestamp — incremented on every local operation */
  timestamp: number;
  /** Unique peer identifier — final tiebreaker for concurrent operations */
  clientId: string;
  /** Tombstoned chars are logically deleted but retained for convergence */
  tombstoned?: boolean;
}

/**
 * Mutation is the wire-format message exchanged between all peers.
 * Every keystroke and deletion is encoded as exactly one Mutation.
 */
export interface Mutation {
  roomId: string;
  clientId: string;
  /** "insert" | "delete" */
  opType: 'insert' | 'delete';
  /** Fractional position of the affected character */
  charId: number;
  /** Character value for inserts; empty string for deletes */
  value: string;
  /** Lamport timestamp at the time of this operation */
  timestamp: number;
}

/**
 * InitMessage is sent by the server to a newly joining client.
 * It contains the full current document state so the client can
 * reconstruct the CRDT array without replaying all past mutations.
 */
export interface InitMessage {
  type: 'init';
  chars: Char[];
}

/** Union of all message types received from the server */
export type ServerMessage = Mutation | InitMessage;

/** Connection state of the WebSocket */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Information about a connected peer (displayed in the UI) */
export interface Peer {
  clientId: string;
  isAI: boolean;
  lastSeen: number;
}
