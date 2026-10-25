package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestDefaults(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != 8080 || cfg.MaxDocAtoms != 200000 || cfg.AIEnabled() || len(cfg.AllowedOrigins) != 2 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestValidationErrors(t *testing.T) {
	cases := map[string]map[string]string{
		"bad port":            {"PORT": "99999"},
		"non-numeric limit":   {"MAX_DOC_ATOMS": "lots"},
		"origin with path":    {"ALLOWED_ORIGINS": "https://example.com/app"},
		"origin bad scheme":   {"ALLOWED_ORIGINS": "ftp://example.com"},
		"key without model":   {"LLM_API_KEY": "k"},
		"bad llm url":         {"LLM_API_KEY": "k", "LLM_MODEL": "m", "LLM_API_URL": "not a url"},
		"missing static dir":  {"STATIC_DIR": "/definitely/not/here"},
		"unknown log format":  {"LOG_FORMAT": "xml"},
		"message limit small": {"MAX_MESSAGE_BYTES": "10"},
	}
	for name, m := range cases {
		if _, err := Load(env(m)); err == nil {
			t.Errorf("%s: expected a validation error", name)
		}
	}
}

func TestValidAIAndStaticConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(env(map[string]string{
		"LLM_API_KEY": "k", "LLM_MODEL": "m", "STATIC_DIR": dir,
		"ALLOWED_ORIGINS": " https://a.example , http://b.example:3000/ ",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AIEnabled() || strings.Join(cfg.AllowedOrigins, ",") != "https://a.example,http://b.example:3000" {
		t.Fatalf("got %+v", cfg)
	}
}
