// main.go — entry point for the Real-Time Collaborative Editor server.
//
// Startup sequence:
//  1. Load configuration from environment variables.
//  2. Initialize the CRDT Hub and start its event loop.
//  3. Register HTTP/WebSocket endpoints.
//  4. Start the HTTP server with graceful shutdown support.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yourusername/collab-editor/api"
	"github.com/yourusername/collab-editor/hub"
)

func main() {
	// ── Configuration ────────────────────────────────────────────────────────
	port := getEnv("PORT", "8080")
	llmAPIKey := getEnv("LLM_API_KEY", "") // Optional — agent degrades gracefully
	llmAPIURL := getEnv("LLM_API_URL", "https://api.openai.com/v1")

	log.Printf("╔══════════════════════════════════════════╗")
	log.Printf("║  Real-Time Collaborative Editor Server  ║")
	log.Printf("╚══════════════════════════════════════════╝")
	log.Printf("Port:        %s", port)
	log.Printf("LLM API:     %s", func() string {
		if llmAPIKey != "" {
			return llmAPIURL + " (configured)"
		}
		return "not configured (agent in demo mode)"
	}())

	// ── Hub Initialization ───────────────────────────────────────────────────
	// The Hub runs as a single background goroutine that serializes all
	// room/client mutations — safe concurrency without coarse-grained locking.
	h := hub.NewHub()
	go h.Run()
	log.Printf("Hub started")

	// ── HTTP Routes ───────────────────────────────────────────────────────────
	mux := http.NewServeMux()
	handler := api.NewHandler(h, llmAPIKey, llmAPIURL)
	handler.RegisterRoutes(mux)

	// CORS middleware — allows the React dev server (localhost:3000) to connect
	corsMiddleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}

	// ── HTTP Server with Graceful Shutdown ────────────────────────────────────
	server := &http.Server{
		Addr:         ":" + port,
		Handler:      corsMiddleware(mux),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start in background goroutine to allow graceful shutdown handling
	go func() {
		log.Printf("Listening on http://localhost:%s", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Block until OS signal (Ctrl+C, SIGTERM from Docker/k8s)
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down gracefully...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Forced shutdown: %v", err)
	}
	log.Println("Server stopped cleanly")
}

// getEnv reads an environment variable with a fallback default.
func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
