// Package ai calls an OpenAI-compatible chat-completions endpoint to produce
// writing suggestions when a user asks for one. Suggestions go back only to
// the requesting client, which decides whether to insert them.
//
// Document text and prompts are never logged.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// Error carries a stable code for clients.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

// ErrorCode implements hub.CodedError.
func (e *Error) ErrorCode() string { return e.Code }

// Client talks to an OpenAI-compatible API.
type Client struct {
	BaseURL        string
	APIKey         string
	Model          string
	HTTP           *http.Client
	MaxOutputRunes int
}

// New returns a client. Timeouts are applied per request via context.
func New(baseURL, apiKey, model string) *Client {
	return &Client{
		BaseURL:        strings.TrimRight(baseURL, "/"),
		APIKey:         apiKey,
		Model:          model,
		HTTP:           &http.Client{Timeout: 60 * time.Second},
		MaxOutputRunes: 2000,
	}
}

const systemPrompt = "You are a writing assistant. Continue the user's text naturally in 1-3 sentences. Do not repeat existing text. No preamble."

// Suggest returns a continuation of text.
func (c *Client) Suggest(ctx context.Context, text string) (string, error) {
	body, err := json.Marshal(map[string]interface{}{
		"model":      c.Model,
		"max_tokens": 160,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": text},
		},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", &Error{Code: "provider_error", Msg: "could not reach the AI provider"}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", &Error{Code: "provider_error", Msg: "failed reading AI provider response"}
	}
	switch {
	case resp.StatusCode == http.StatusTooManyRequests:
		return "", &Error{Code: "rate_limited", Msg: "the AI provider is rate limiting requests"}
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return "", &Error{Code: "provider_auth", Msg: "the AI provider rejected the configured credentials"}
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return "", &Error{Code: "provider_error", Msg: fmt.Sprintf("the AI provider returned status %d", resp.StatusCode)}
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content *string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || len(parsed.Choices) == 0 || parsed.Choices[0].Message.Content == nil {
		return "", &Error{Code: "provider_error", Msg: "malformed AI provider response"}
	}
	out := strings.TrimSpace(*parsed.Choices[0].Message.Content)
	if !utf8.ValidString(out) {
		out = strings.ToValidUTF8(out, "\uFFFD")
	}
	if utf8.RuneCountInString(out) > c.MaxOutputRunes {
		out = string([]rune(out)[:c.MaxOutputRunes])
	}
	if out == "" {
		return "", &Error{Code: "empty_response", Msg: "the AI provider returned an empty suggestion"}
	}
	return out, nil
}
