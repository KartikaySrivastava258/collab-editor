// Command collab-editor-server runs the real-time collaborative editor.
//
// Startup: load + validate config (fail fast), build the hub, optionally the
// AI client, then serve HTTP. On SIGINT/SIGTERM: readiness flips to 503,
// WebSocket clients get close code 1001, then the listener shuts down.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"collab-editor/ai"
	"collab-editor/api"
	"collab-editor/config"
	"collab-editor/hub"
)

func main() {
	// `collab-editor-server healthcheck` probes /healthz on the configured port
	// and exits 0/1. Used by Docker HEALTHCHECK (the runtime image has no shell).
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var handler slog.Handler = slog.NewJSONHandler(os.Stdout, nil)
	if cfg.LogFormat == "text" {
		handler = slog.NewTextHandler(os.Stdout, nil)
	}
	log := slog.New(handler)

	hubCfg := hub.Config{
		MaxDocAtoms:       cfg.MaxDocAtoms,
		MaxRooms:          cfg.MaxRooms,
		MaxClientsPerRoom: cfg.MaxClientsPerRoom,
		MaxMessageBytes:   cfg.MaxMessageBytes,
		AITimeout:         cfg.AITimeout,
		Logger:            log,
	}
	if cfg.AIEnabled() {
		hubCfg.AI = ai.New(cfg.LLMAPIURL, cfg.LLMAPIKey, cfg.LLMModel)
	}
	h := hub.New(hubCfg)

	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           api.New(h, cfg.AllowedOrigins, cfg.StaticDir, log),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "port", cfg.Port, "ai_enabled", cfg.AIEnabled(), "static", cfg.StaticDir != "",
			"allowed_origins", cfg.AllowedOrigins, "persistence", "memory")
		errCh <- srv.ListenAndServe()
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case sig := <-stop:
		log.Info("shutdown_started", "signal", sig.String())
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Error("server_error", "error", err.Error())
			os.Exit(1)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := h.Shutdown(ctx); err != nil {
		log.Warn("hub_shutdown_timeout", "error", err.Error())
	}
	if err := srv.Shutdown(ctx); err != nil {
		log.Warn("http_shutdown_timeout", "error", err.Error())
	}
	log.Info("shutdown_complete")
}

func healthcheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
