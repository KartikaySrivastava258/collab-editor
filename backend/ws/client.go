package ws

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Dial opens a client connection (ws:// only). It exists for integration
// tests and the load-generation tool; browsers use their own implementation.
// origin may be empty, in which case no Origin header is sent.
func Dial(ctx context.Context, rawURL, origin string, opts Options) (*Conn, *http.Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, nil, err
	}
	if u.Scheme != "ws" {
		return nil, nil, fmt.Errorf("ws: unsupported scheme %q", u.Scheme)
	}
	host := u.Host
	if !strings.Contains(host, ":") {
		host += ":80"
	}
	var d net.Dialer
	netConn, err := d.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = netConn.SetDeadline(deadline)
	} else {
		_ = netConn.SetDeadline(time.Now().Add(10 * time.Second))
	}
	var keyBytes [16]byte
	if _, err := rand.Read(keyBytes[:]); err != nil {
		netConn.Close()
		return nil, nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes[:])
	path := u.RequestURI()
	req := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n"
	if origin != "" {
		req += "Origin: " + origin + "\r\n"
	}
	req += "\r\n"
	if _, err := netConn.Write([]byte(req)); err != nil {
		netConn.Close()
		return nil, nil, err
	}
	br := bufio.NewReader(netConn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		netConn.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		netConn.Close()
		return nil, resp, fmt.Errorf("ws: handshake status %d", resp.StatusCode)
	}
	if resp.Header.Get("Sec-WebSocket-Accept") != computeAccept(key) {
		netConn.Close()
		return nil, resp, fmt.Errorf("ws: bad Sec-WebSocket-Accept")
	}
	_ = netConn.SetDeadline(time.Time{})
	return newConn(netConn, br, opts, true), resp, nil
}
