// Package ws is a small RFC 6455 WebSocket implementation built on the
// standard library.
//
// Guarantees:
//   - Message size is bounded before allocation (cumulative across fragments).
//   - Client frames must be masked; RSV bits, opcodes, fragmentation and
//     control-frame rules are enforced; text must be valid UTF-8.
//   - All writes are serialized by a mutex, so the reader can answer pings and
//     close frames while another goroutine writes data frames.
//   - Every frame (including pongs) extends the read deadline, so idle but
//     healthy connections are not dropped.
//
// The backend deliberately has no third-party modules. If that constraint is
// ever dropped, github.com/coder/websocket is a good drop-in replacement
// (see docs/KNOWN_LIMITATIONS.md).
package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const acceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Frame opcodes (RFC 6455 §5.2).
const (
	opContinuation byte = 0x0
	opText         byte = 0x1
	opBinary       byte = 0x2
	opClose        byte = 0x8
	opPing         byte = 0x9
	opPong         byte = 0xA
)

// MessageType distinguishes text and binary data messages.
type MessageType int

const (
	// TextMessage is a UTF-8 text message.
	TextMessage MessageType = 1
	// BinaryMessage is a binary message.
	BinaryMessage MessageType = 2
)

// Close codes.
const (
	CloseNormal         = 1000
	CloseGoingAway      = 1001
	CloseProtocolError  = 1002
	CloseNoStatus       = 1005
	CloseInvalidPayload = 1007
	ClosePolicy         = 1008
	CloseTooBig         = 1009
)

// ErrCloseSent is returned when writing after a close frame was sent.
var ErrCloseSent = errors.New("ws: close frame already sent")

// CloseError reports a close frame received from the peer, or a protocol
// violation that made us close the connection.
type CloseError struct {
	Code int
	Text string
}

func (e *CloseError) Error() string { return fmt.Sprintf("ws: closed (%d %s)", e.Code, e.Text) }

// HandshakeError is returned by Upgrade; the HTTP response was already written.
type HandshakeError struct {
	Status int
	Msg    string
}

func (e *HandshakeError) Error() string { return "ws: handshake failed: " + e.Msg }

// Options configures a connection.
type Options struct {
	// MaxMessageBytes bounds a complete (possibly fragmented) message.
	MaxMessageBytes int64
	// ReadTimeout is the longest allowed gap between incoming frames.
	ReadTimeout time.Duration
	// WriteTimeout bounds each frame write.
	WriteTimeout time.Duration
}

// Conn is a WebSocket connection. ReadMessage must be called from one
// goroutine; write methods are safe for concurrent use.
type Conn struct {
	conn      net.Conn
	br        *bufio.Reader
	opts      Options
	isClient  bool
	writeMu   sync.Mutex
	closeSent bool
}

func computeAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key + acceptGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

func reject(w http.ResponseWriter, status int, msg string) error {
	if status == http.StatusUpgradeRequired {
		w.Header().Set("Sec-WebSocket-Version", "13")
	}
	http.Error(w, msg, status)
	return &HandshakeError{Status: status, Msg: msg}
}

// Upgrade validates the handshake (RFC 6455 §4.2) and takes over the
// connection. Origin policy must be checked by the caller beforehand.
func Upgrade(w http.ResponseWriter, r *http.Request, opts Options) (*Conn, error) {
	if r.Method != http.MethodGet {
		return nil, reject(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	if !headerHasToken(r.Header, "Connection", "upgrade") || !headerHasToken(r.Header, "Upgrade", "websocket") {
		return nil, reject(w, http.StatusBadRequest, "not a websocket upgrade")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, reject(w, http.StatusUpgradeRequired, "unsupported websocket version")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if raw, err := base64.StdEncoding.DecodeString(key); err != nil || len(raw) != 16 {
		return nil, reject(w, http.StatusBadRequest, "invalid Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, reject(w, http.StatusInternalServerError, "connection cannot be upgraded")
	}
	netConn, brw, err := hj.Hijack()
	if err != nil {
		return nil, &HandshakeError{Status: http.StatusInternalServerError, Msg: err.Error()}
	}
	if brw.Reader.Buffered() > 0 {
		netConn.Close()
		return nil, &HandshakeError{Status: http.StatusBadRequest, Msg: "client sent data before handshake completed"}
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + computeAccept(key) + "\r\n\r\n"
	if opts.WriteTimeout > 0 {
		_ = netConn.SetWriteDeadline(time.Now().Add(opts.WriteTimeout))
	}
	if _, err := netConn.Write([]byte(resp)); err != nil {
		netConn.Close()
		return nil, &HandshakeError{Status: http.StatusInternalServerError, Msg: err.Error()}
	}
	return newConn(netConn, brw.Reader, opts, false), nil
}

func newConn(c net.Conn, br *bufio.Reader, opts Options, isClient bool) *Conn {
	if opts.MaxMessageBytes <= 0 {
		opts.MaxMessageBytes = 1 << 20
	}
	return &Conn{conn: c, br: br, opts: opts, isClient: isClient}
}

// RemoteAddr returns the peer address.
func (c *Conn) RemoteAddr() net.Addr { return c.conn.RemoteAddr() }

// Close closes the underlying connection without a close handshake.
func (c *Conn) Close() error { return c.conn.Close() }

// fail sends a close frame for a protocol violation and returns the error.
func (c *Conn) fail(code int, text string) (MessageType, []byte, error) {
	_ = c.WriteClose(code, text)
	return 0, nil, &CloseError{Code: code, Text: text}
}

// ReadMessage returns the next complete data message. Pings are answered and
// pongs consumed internally. A received close frame is answered and returned
// as *CloseError.
func (c *Conn) ReadMessage() (MessageType, []byte, error) {
	var msg []byte
	var msgOp byte
	fragmented := false
	for {
		if c.opts.ReadTimeout > 0 {
			_ = c.conn.SetReadDeadline(time.Now().Add(c.opts.ReadTimeout))
		}
		var hdr [2]byte
		if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
			return 0, nil, err
		}
		fin := hdr[0]&0x80 != 0
		if hdr[0]&0x70 != 0 {
			return c.fail(CloseProtocolError, "reserved bits set")
		}
		op := hdr[0] & 0x0F
		masked := hdr[1]&0x80 != 0
		if masked == c.isClient {
			if c.isClient {
				return c.fail(CloseProtocolError, "server frames must not be masked")
			}
			return c.fail(CloseProtocolError, "client frames must be masked")
		}
		n := int64(hdr[1] & 0x7F)
		switch n {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return 0, nil, err
			}
			n = int64(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return 0, nil, err
			}
			u := binary.BigEndian.Uint64(ext[:])
			if u > uint64(c.opts.MaxMessageBytes) {
				return c.fail(CloseTooBig, "message too big")
			}
			n = int64(u)
		}
		isControl := op&0x8 != 0
		if isControl && (!fin || n > 125) {
			return c.fail(CloseProtocolError, "invalid control frame")
		}
		if !isControl && int64(len(msg))+n > c.opts.MaxMessageBytes {
			return c.fail(CloseTooBig, "message too big")
		}
		var mask [4]byte
		if masked {
			if _, err := io.ReadFull(c.br, mask[:]); err != nil {
				return 0, nil, err
			}
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(c.br, payload); err != nil {
			return 0, nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
		switch op {
		case opClose:
			code := CloseNoStatus
			text := ""
			if len(payload) == 1 {
				return c.fail(CloseProtocolError, "invalid close payload")
			}
			if len(payload) >= 2 {
				code = int(binary.BigEndian.Uint16(payload[:2]))
				text = string(payload[2:])
			}
			reply := code
			if reply == CloseNoStatus {
				reply = CloseNormal
			}
			_ = c.WriteClose(reply, "")
			return 0, nil, &CloseError{Code: code, Text: text}
		case opPing:
			if err := c.writeFrame(opPong, payload); err != nil && !errors.Is(err, ErrCloseSent) {
				return 0, nil, err
			}
			continue
		case opPong:
			continue
		case opText, opBinary:
			if fragmented {
				return c.fail(CloseProtocolError, "new message inside fragmented message")
			}
			msgOp = op
			msg = payload
			if !fin {
				fragmented = true
				continue
			}
		case opContinuation:
			if !fragmented {
				return c.fail(CloseProtocolError, "continuation without start")
			}
			msg = append(msg, payload...)
			if !fin {
				continue
			}
		default:
			return c.fail(CloseProtocolError, "unknown opcode")
		}
		if msgOp == opText && !utf8.Valid(msg) {
			return c.fail(CloseInvalidPayload, "invalid UTF-8")
		}
		return MessageType(msgOp), msg, nil
	}
}

func (c *Conn) writeFrame(op byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closeSent {
		return ErrCloseSent
	}
	if op == opClose {
		c.closeSent = true
	}
	n := len(payload)
	buf := make([]byte, 0, 14+n)
	buf = append(buf, 0x80|op)
	maskBit := byte(0)
	if c.isClient {
		maskBit = 0x80
	}
	switch {
	case n <= 125:
		buf = append(buf, maskBit|byte(n))
	case n <= 0xFFFF:
		buf = append(buf, maskBit|126, byte(n>>8), byte(n))
	default:
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		buf = append(buf, maskBit|127)
		buf = append(buf, ext[:]...)
	}
	if c.isClient {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return err
		}
		buf = append(buf, mask[:]...)
		start := len(buf)
		buf = append(buf, payload...)
		for i := start; i < len(buf); i++ {
			buf[i] ^= mask[(i-start)%4]
		}
	} else {
		buf = append(buf, payload...)
	}
	if c.opts.WriteTimeout > 0 {
		_ = c.conn.SetWriteDeadline(time.Now().Add(c.opts.WriteTimeout))
	}
	_, err := c.conn.Write(buf)
	return err
}

// WriteText sends a text message.
func (c *Conn) WriteText(data []byte) error { return c.writeFrame(opText, data) }

// WriteBinary sends a binary message.
func (c *Conn) WriteBinary(data []byte) error { return c.writeFrame(opBinary, data) }

// Ping sends a ping control frame.
func (c *Conn) Ping() error { return c.writeFrame(opPing, nil) }

// WriteClose sends a close frame (once). The reason is truncated to fit.
func (c *Conn) WriteClose(code int, reason string) error {
	if len(reason) > 123 {
		reason = reason[:123]
	}
	payload := make([]byte, 2, 2+len(reason))
	binary.BigEndian.PutUint16(payload, uint16(code))
	payload = append(payload, reason...)
	return c.writeFrame(opClose, payload)
}

// WriteRawFrame writes an arbitrary single frame. Intended for tests that
// exercise protocol violations.
func (c *Conn) WriteRawFrame(fin bool, op byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	first := op
	if fin {
		first |= 0x80
	}
	hdr := []byte{first}
	maskBit := byte(0)
	if c.isClient {
		maskBit = 0x80
	}
	n := len(payload)
	switch {
	case n <= 125:
		hdr = append(hdr, maskBit|byte(n))
	case n <= 0xFFFF:
		hdr = append(hdr, maskBit|126, byte(n>>8), byte(n))
	default:
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		hdr = append(hdr, maskBit|127)
		hdr = append(hdr, ext[:]...)
	}
	body := append([]byte(nil), payload...)
	if c.isClient {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return err
		}
		hdr = append(hdr, mask[:]...)
		for i := range body {
			body[i] ^= mask[i%4]
		}
	}
	_, err := c.conn.Write(append(hdr, body...))
	return err
}
