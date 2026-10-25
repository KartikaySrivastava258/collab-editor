// Package config loads and validates server configuration from environment
// variables. Invalid configuration fails fast at startup (see .env.example).
package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config is the validated server configuration.
type Config struct {
	Port              int
	AllowedOrigins    []string
	StaticDir         string
	MaxDocAtoms       int
	MaxRooms          int
	MaxClientsPerRoom int
	MaxMessageBytes   int64
	LLMAPIKey         string
	LLMAPIURL         string
	LLMModel          string
	AITimeout         time.Duration
	ShutdownTimeout   time.Duration
	LogFormat         string
}

// AIEnabled reports whether AI suggestions are configured.
func (c Config) AIEnabled() bool { return c.LLMAPIKey != "" }

// Load reads configuration using getenv (os.Getenv in production).
func Load(getenv func(string) string) (Config, error) {
	var errs []string
	str := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}
	num := func(key string, def, min, max int) int {
		raw := str(key, "")
		if raw == "" {
			return def
		}
		v, err := strconv.Atoi(raw)
		if err != nil || v < min || v > max {
			errs = append(errs, fmt.Sprintf("%s must be an integer in [%d, %d], got %q", key, min, max, raw))
			return def
		}
		return v
	}
	cfg := Config{
		Port:              num("PORT", 8080, 1, 65535),
		StaticDir:         str("STATIC_DIR", ""),
		MaxDocAtoms:       num("MAX_DOC_ATOMS", 200000, 1, 5000000),
		MaxRooms:          num("MAX_ROOMS", 100, 1, 100000),
		MaxClientsPerRoom: num("MAX_CLIENTS_PER_ROOM", 50, 1, 10000),
		MaxMessageBytes:   int64(num("MAX_MESSAGE_BYTES", 256*1024, 4096, 16*1024*1024)),
		LLMAPIKey:         str("LLM_API_KEY", ""),
		LLMAPIURL:         str("LLM_API_URL", "https://api.openai.com/v1"),
		LLMModel:          str("LLM_MODEL", ""),
		AITimeout:         time.Duration(num("AI_TIMEOUT_MS", 20000, 1000, 120000)) * time.Millisecond,
		ShutdownTimeout:   time.Duration(num("SHUTDOWN_TIMEOUT_MS", 10000, 100, 120000)) * time.Millisecond,
		LogFormat:         str("LOG_FORMAT", "json"),
	}
	for _, o := range strings.Split(str("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"), ",") {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		u, err := url.Parse(o)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") {
			errs = append(errs, fmt.Sprintf("ALLOWED_ORIGINS entry %q must look like https://host[:port]", o))
			continue
		}
		cfg.AllowedOrigins = append(cfg.AllowedOrigins, u.Scheme+"://"+u.Host)
	}
	if cfg.LLMAPIKey != "" {
		if cfg.LLMModel == "" {
			errs = append(errs, "LLM_MODEL is required when LLM_API_KEY is set")
		}
		if u, err := url.Parse(cfg.LLMAPIURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, fmt.Sprintf("LLM_API_URL %q is not a valid http(s) URL", cfg.LLMAPIURL))
		}
	}
	if cfg.StaticDir != "" {
		if _, err := os.Stat(filepath.Join(cfg.StaticDir, "index.html")); err != nil {
			errs = append(errs, fmt.Sprintf("STATIC_DIR %q does not contain index.html", cfg.StaticDir))
		}
	}
	if cfg.LogFormat != "json" && cfg.LogFormat != "text" {
		errs = append(errs, "LOG_FORMAT must be json or text")
	}
	if len(errs) > 0 {
		return cfg, fmt.Errorf("invalid configuration:\n  - %s", strings.Join(errs, "\n  - "))
	}
	return cfg, nil
}
