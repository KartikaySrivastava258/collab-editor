// Package api exposes the HTTP surface:
//
//	GET /ws?roomId=&clientId=&name=   WebSocket (protocol v2, docs/PROTOCOL.md)
//	GET /health, /healthz             liveness
//	GET /readyz                       readiness (503 while shutting down)
//	GET /api/room/text?roomId=        current text of an in-memory room
//	GET /*                            built frontend, when STATIC_DIR is set
package api

import (
	"bufio"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"collab-editor/crdt"
	"collab-editor/hub"
	"collab-editor/ws"
)

// Server is the HTTP handler.
type Server struct {
	hub     *hub.Hub
	origins map[string]bool
	static  string
	log     *slog.Logger
	mux     *http.ServeMux
}

// New builds the handler. staticDir may be empty.
func New(h *hub.Hub, allowedOrigins []string, staticDir string, log *slog.Logger) http.Handler {
	s := &Server{hub: h, origins: make(map[string]bool), static: staticDir, log: log, mux: http.NewServeMux()}
	for _, o := range allowedOrigins {
		s.origins[o] = true
	}
	s.mux.HandleFunc("/ws", s.serveWS)
	s.mux.HandleFunc("/health", s.health)
	s.mux.HandleFunc("/healthz", s.health)
	s.mux.HandleFunc("/readyz", s.ready)
	s.mux.HandleFunc("/api/room/text", s.roomText)
	s.mux.HandleFunc("/", s.fallback)
	return s.middleware(s.mux)
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errorJSON(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

// originAllowed: requests without Origin (non-browser clients) are allowed;
// browsers must match the allowlist or the server's own host.
func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if s.origins[origin] {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host != "" && u.Host == r.Host
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	roomID, clientID := q.Get("roomId"), q.Get("clientId")
	if !hub.ValidRoomID(roomID) || !crdt.ValidClientID(clientID) {
		http.Error(w, "invalid roomId or clientId", http.StatusBadRequest)
		return
	}
	if !s.originAllowed(r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	if err := s.hub.Admit(roomID, clientID); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	conn, err := ws.Upgrade(w, r, s.hub.ConnOptions())
	if err != nil {
		s.log.Info("ws_upgrade_failed", "error", err.Error())
		return
	}
	s.hub.Serve(conn, roomID, clientID, SanitizeName(q.Get("name")))
}

// SanitizeName mirrors sanitizeName() in the TS protocol module.
func SanitizeName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	runes := []rune(strings.TrimSpace(b.String()))
	if len(runes) > 32 {
		runes = runes[:32]
	}
	if len(runes) == 0 {
		return "Guest"
	}
	return string(runes)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "collab-editor", "implementation": "go"})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if !s.hub.Ready() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]bool{"ready": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ready": true})
}

func (s *Server) roomText(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" {
		if !s.originAllowed(r) {
			errorJSON(w, http.StatusForbidden, "origin_not_allowed")
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		errorJSON(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	roomID := r.URL.Query().Get("roomId")
	if !hub.ValidRoomID(roomID) {
		errorJSON(w, http.StatusBadRequest, "invalid_room_id")
		return
	}
	info, ok := s.hub.Room(roomID)
	if !ok {
		errorJSON(w, http.StatusNotFound, "room_not_found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"roomId": roomID, "text": info.Text, "lamportClock": info.Lamport, "epoch": info.Epoch, "clients": info.Clients,
	})
}

const csp = "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

func (s *Server) fallback(w http.ResponseWriter, r *http.Request) {
	if s.static == "" || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		errorJSON(w, http.StatusNotFound, "not_found")
		return
	}
	clean := path.Clean("/" + r.URL.Path)
	file := filepath.Join(s.static, filepath.FromSlash(clean))
	if st, err := os.Stat(file); err != nil || st.IsDir() {
		file = filepath.Join(s.static, "index.html") // SPA fallback
	}
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, file)
}

// ── middleware ──────────────────────────────────────────────────────────────

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Hijack forwards to the underlying writer so WebSocket upgrades work.
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("hijacking not supported")
	}
	r.status = http.StatusSwitchingProtocols
	return hj.Hijack()
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		// Path only: query strings are not logged.
		s.log.Info("http", "method", r.Method, "path", r.URL.Path, "status", rec.status, "ms", time.Since(start).Milliseconds())
	})
}
