package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSuggestSendsModelAndKeyAndTrims(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer key" || body.Model != "model-x" || body.Messages[1].Content != "doc" {
			http.Error(w, "bad", 400)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"  next words  "}}]}`))
	}))
	defer srv.Close()
	got, err := New(srv.URL+"/", "key", "model-x").Suggest(context.Background(), "doc")
	if err != nil || got != "next words" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestSuggestTruncatesLongOutput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"choices": []interface{}{map[string]interface{}{"message": map[string]string{"content": strings.Repeat("é", 5000)}}}})
	}))
	defer srv.Close()
	c := New(srv.URL, "k", "m")
	got, err := c.Suggest(context.Background(), "x")
	if err != nil || len([]rune(got)) != c.MaxOutputRunes {
		t.Fatalf("len %d err %v", len([]rune(got)), err)
	}
}

func TestSuggestErrorCodes(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"rate_limited":   func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(429) },
		"provider_auth":  func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) },
		"provider_error": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`not json`)) },
		"empty_response": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"choices":[{"message":{"content":" "}}]}`)) },
	}
	for want, h := range cases {
		srv := httptest.NewServer(h)
		_, err := New(srv.URL, "k", "m").Suggest(context.Background(), "x")
		srv.Close()
		var e *Error
		if !errors.As(err, &e) || e.ErrorCode() != want {
			t.Errorf("%s: got %v", want, err)
		}
	}
}

func TestSuggestHonoursContextTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := New(srv.URL, "k", "m").Suggest(ctx, "x")
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 2*time.Second {
		t.Fatalf("err=%v after %v", err, time.Since(start))
	}
}
