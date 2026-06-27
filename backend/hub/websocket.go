// Package hub — websocket.go implements the WebSocket protocol (RFC 6455)
// from scratch using only Go's standard library net/http and crypto packages.
//
// Why no gorilla/websocket?
//   Implementing the handshake and framing ourselves makes the distributed
//   systems mechanics maximally visible to code reviewers, and removes all
//   external dependencies — the entire project can be audited end-to-end.
//
// Implemented:
//   - HTTP → WebSocket upgrade (Sec-WebSocket-Accept handshake)
//   - Frame parsing: FIN, opcode, masking, payload length (7-bit, 16-bit, 64-bit)
//   - Frame writing: server frames are never masked (RFC 6455 §5.1)
//   - Opcodes: Text (0x1), Binary (0x2), Close (0x8), Ping (0x9), Pong (0xA)
//   - Control frame handling (ping → pong, close → close echo)
package hub

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// RFC 6455 Constants
// ─────────────────────────────────────────────────────────────────────────────

const (
	wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11" // RFC 6455 §1.3

	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA

	maxControlFramePayload = 125 // RFC 6455 §5.5
)

// ─────────────────────────────────────────────────────────────────────────────
// WSConn — a WebSocket connection over a hijacked HTTP connection
// ─────────────────────────────────────────────────────────────────────────────

// WSConn wraps a raw TCP connection with WebSocket framing.
// After Upgrade(), the HTTP connection is "hijacked" and owned by WSConn.
type WSConn struct {
	conn net.Conn
	rw   *bufio.ReadWriter
}

// Upgrade performs the WebSocket handshake on an incoming HTTP request.
// On success, returns a WSConn owning the underlying TCP connection.
// On failure, writes an HTTP error response and returns an error.
func Upgrade(w http.ResponseWriter, r *http.Request) (*WSConn, error) {
	// Validate upgrade request per RFC 6455 §4.2.1
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "not a websocket upgrade", http.StatusBadRequest)
		return nil, errors.New("missing Upgrade: websocket header")
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		http.Error(w, "missing connection upgrade", http.StatusBadRequest)
		return nil, errors.New("missing Connection: Upgrade header")
	}
	if r.Header.Get("Sec-Websocket-Version") != "13" {
		http.Error(w, "unsupported websocket version", http.StatusBadRequest)
		return nil, errors.New("websocket version != 13")
	}

	clientKey := r.Header.Get("Sec-Websocket-Key")
	if clientKey == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, errors.New("missing Sec-WebSocket-Key")
	}

	// Compute Sec-WebSocket-Accept: base64(SHA1(clientKey + GUID))
	h := sha1.New()
	h.Write([]byte(clientKey + wsGUID))
	acceptKey := base64.StdEncoding.EncodeToString(h.Sum(nil))

	// Hijack the HTTP connection — we now own the raw TCP socket
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return nil, errors.New("ResponseWriter does not implement http.Hijacker")
	}

	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, fmt.Errorf("hijack failed: %w", err)
	}

	// Write the 101 Switching Protocols response directly to the raw connection
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKey + "\r\n" +
		"\r\n"

	if _, err := rw.WriteString(response); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to write upgrade response: %w", err)
	}
	if err := rw.Flush(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to flush upgrade response: %w", err)
	}

	return &WSConn{conn: conn, rw: rw}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame Reading (RFC 6455 §5.2)
// ─────────────────────────────────────────────────────────────────────────────

// ReadMessage reads one complete WebSocket message from the connection.
// Handles fragmentation (continuation frames) transparently.
// Returns (opcode, payload, error).
//
// Frame layout:
//
//	Byte 0: FIN(1) RSV1(1) RSV2(1) RSV3(1) Opcode(4)
//	Byte 1: MASK(1) PayloadLen(7)      [if len == 126: +2 bytes] [if 127: +8 bytes]
//	[4 bytes masking key if MASK==1]
//	[payload bytes, XOR'd with masking key if MASK==1]
func (c *WSConn) ReadMessage() (opcode byte, payload []byte, err error) {
	var finalPayload []byte
	var finalOpcode byte

	for {
		// Read first two header bytes
		header := make([]byte, 2)
		if _, err = io.ReadFull(c.rw, header); err != nil {
			return 0, nil, fmt.Errorf("read header: %w", err)
		}

		fin := (header[0] & 0x80) != 0
		op := header[0] & 0x0F
		masked := (header[1] & 0x80) != 0
		payloadLen := uint64(header[1] & 0x7F)

		// Extended payload length
		switch payloadLen {
		case 126:
			var extLen [2]byte
			if _, err = io.ReadFull(c.rw, extLen[:]); err != nil {
				return 0, nil, fmt.Errorf("read ext16 len: %w", err)
			}
			payloadLen = uint64(binary.BigEndian.Uint16(extLen[:]))
		case 127:
			var extLen [8]byte
			if _, err = io.ReadFull(c.rw, extLen[:]); err != nil {
				return 0, nil, fmt.Errorf("read ext64 len: %w", err)
			}
			payloadLen = binary.BigEndian.Uint64(extLen[:])
		}

		// Read masking key (client → server frames MUST be masked per RFC 6455 §5.1)
		var maskKey [4]byte
		if masked {
			if _, err = io.ReadFull(c.rw, maskKey[:]); err != nil {
				return 0, nil, fmt.Errorf("read mask key: %w", err)
			}
		}

		// Read payload
		frame := make([]byte, payloadLen)
		if payloadLen > 0 {
			if _, err = io.ReadFull(c.rw, frame); err != nil {
				return 0, nil, fmt.Errorf("read payload: %w", err)
			}
		}

		// Unmask payload (XOR each byte with the 4-byte rotating key)
		if masked {
			for i := range frame {
				frame[i] ^= maskKey[i%4]
			}
		}

		// Handle control frames inline (they can appear mid-fragmentation)
		switch op {
		case opClose:
			c.WriteMessage(opClose, frame[:min(len(frame), maxControlFramePayload)])
			return opClose, nil, io.EOF

		case opPing:
			c.WriteMessage(opPong, frame[:min(len(frame), maxControlFramePayload)])
			continue // Continue reading data frames

		case opPong:
			continue // Unsolicited pong — ignore
		}

		// Assemble fragmented message
		if op != opContinuation {
			finalOpcode = op
			finalPayload = frame
		} else {
			finalPayload = append(finalPayload, frame...)
		}

		if fin {
			return finalOpcode, finalPayload, nil
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame Writing (RFC 6455 §5.2)
// ─────────────────────────────────────────────────────────────────────────────

// WriteMessage writes a single WebSocket frame to the connection.
// Server frames are NEVER masked (RFC 6455 §5.1 — only client frames are masked).
func (c *WSConn) WriteMessage(opcode byte, payload []byte) error {
	payloadLen := len(payload)

	// Byte 0: FIN=1, RSV=0, opcode
	header := []byte{0x80 | opcode}

	// Byte 1+: payload length (no masking bit — server frames unmasked)
	switch {
	case payloadLen <= 125:
		header = append(header, byte(payloadLen))
	case payloadLen <= 65535:
		header = append(header, 126)
		lenBytes := make([]byte, 2)
		binary.BigEndian.PutUint16(lenBytes, uint16(payloadLen))
		header = append(header, lenBytes...)
	default:
		header = append(header, 127)
		lenBytes := make([]byte, 8)
		binary.BigEndian.PutUint64(lenBytes, uint64(payloadLen))
		header = append(header, lenBytes...)
	}

	if _, err := c.rw.Write(header); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := c.rw.Write(payload); err != nil {
			return err
		}
	}
	return c.rw.Flush()
}

// SetReadDeadline sets a deadline on the underlying TCP connection read.
func (c *WSConn) SetReadDeadline(t time.Time) {
	c.conn.SetReadDeadline(t)
}

// SetWriteDeadline sets a deadline on the underlying TCP connection write.
func (c *WSConn) SetWriteDeadline(t time.Time) {
	c.conn.SetWriteDeadline(t)
}

// Close closes the underlying TCP connection.
func (c *WSConn) Close() {
	c.conn.Close()
}

// RemoteAddr returns the remote network address.
func (c *WSConn) RemoteAddr() net.Addr {
	return c.conn.RemoteAddr()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
