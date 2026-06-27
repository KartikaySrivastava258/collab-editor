// Package agent implements the AI writing agent.
//
// Correct behaviour:
//   - Agent only fires after the USER has been completely silent for 3 seconds.
//   - Agent's own broadcast mutations never reset the debounce timer.
//   - If the user types while the agent is typing, the agent stops instantly.
//   - Agent always appends after the current last character in the document.
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/yourusername/collab-editor/crdt"
	"github.com/yourusername/collab-editor/hub"
)

const (
	AgentClientID = "AI_AGENT"
	DebounceDelay = 3 * time.Second  // wait this long after last HUMAN keystroke
	TypeDelay     = 35 * time.Millisecond
	MinDocLength  = 15
)

type Agent struct {
	roomID     string
	hub        *hub.Hub
	apiKey     string
	apiBaseURL string

	// isTyping is 1 while the agent is actively injecting characters.
	// NotifyUpdate checks this to know whether to cancel.
	isTyping int32

	// cancelTyping stops any in-progress typeText loop.
	cancelTyping context.CancelFunc

	// humanUpdates receives text only from HUMAN mutations (never AI's own).
	humanUpdates chan string

	done           chan struct{}
	agentTimestamp int64
}

func NewAgent(roomID string, h *hub.Hub, apiKey, apiBaseURL string) *Agent {
	return &Agent{
		roomID:       roomID,
		hub:          h,
		apiKey:       apiKey,
		apiBaseURL:   apiBaseURL,
		humanUpdates: make(chan string, 256),
		done:         make(chan struct{}),
		cancelTyping: func() {},
	}
}

// NotifyUpdate is called by the Hub on every mutation.
// The Hub already filters out AI_AGENT mutations before calling this,
// so every call here is guaranteed to be a human keystroke.
func (a *Agent) NotifyUpdate(text string) {
	// If the agent is currently typing, cancel it immediately
	if atomic.LoadInt32(&a.isTyping) == 1 {
		a.cancelTyping()
	}

	// Send to debounce loop, dropping if full (we only need the latest text)
	select {
	case a.humanUpdates <- text:
	default:
		// drain one old entry, insert new
		select {
		case <-a.humanUpdates:
		default:
		}
		select {
		case a.humanUpdates <- text:
		default:
		}
	}
}

func (a *Agent) Start() {
	go a.run()
	log.Printf("[AGENT] Started for room %s", a.roomID)
}

func (a *Agent) Stop() {
	a.cancelTyping()
	close(a.done)
}

// run is the debounce loop. It resets a timer on every human update.
// Only when the timer fires (silence for DebounceDelay) does it trigger the AI.
func (a *Agent) run() {
	var timer *time.Timer
	var latestText string

	// Helper to safely reset the timer
	resetTimer := func() {
		if timer != nil {
			timer.Stop()
			// Drain the channel in case it already fired
			select {
			case <-timer.C:
			default:
			}
		}
		timer = time.NewTimer(DebounceDelay)
	}

	for {
		// Build the timer channel reference safely
		var timerC <-chan time.Time
		if timer != nil {
			timerC = timer.C
		}

		select {
		case <-a.done:
			if timer != nil {
				timer.Stop()
			}
			return

		case text := <-a.humanUpdates:
			// Human typed — absorb ALL queued updates (get freshest text)
			latestText = text
		drain:
			for {
				select {
				case t := <-a.humanUpdates:
					latestText = t
				default:
					break drain
				}
			}
			// Reset the silence timer — must be quiet for DebounceDelay
			resetTimer()

		case <-timerC:
			// User has been silent for DebounceDelay — trigger AI
			timer = nil
			text := strings.TrimSpace(latestText)
			if len(text) < MinDocLength {
				continue
			}

			log.Printf("[AGENT] User silent for %v — generating response (%d chars)", DebounceDelay, len(text))

			// Cancel any previous (shouldn't exist, but be safe)
			a.cancelTyping()

			ctx, cancel := context.WithCancel(context.Background())
			a.cancelTyping = cancel

			snapshot := text
			go func() {
				defer cancel()
				a.generateAndType(ctx, snapshot)
			}()
		}
	}
}

// generateAndType calls LLM (or fallback) then types the response.
func (a *Agent) generateAndType(ctx context.Context, docText string) {
	response, err := a.callLLM(ctx, docText)
	if err != nil {
		if ctx.Err() != nil {
			return // cancelled — silent exit
		}
		log.Printf("[AGENT] LLM unavailable (%v) — using demo response", err)
		response = a.fallbackResponse(docText)
	}

	response = strings.TrimSpace(response)
	if response == "" || ctx.Err() != nil {
		return
	}

	toType := "\n\n[AI]: " + response
	log.Printf("[AGENT] Typing %d chars", len(toType))
	a.typeText(ctx, toType)
}

func (a *Agent) callLLM(ctx context.Context, docText string) (string, error) {
	if a.apiKey == "" || a.apiBaseURL == "" {
		return "", fmt.Errorf("no API key")
	}

	type msg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	body, _ := json.Marshal(map[string]interface{}{
		"model": "llama-3.3-70b-versatile",
		"messages": []msg{
			{Role: "system", Content: `You are a helpful writing assistant in a real-time collaborative editor.
The user has paused. Continue their text naturally in 1-3 sentences.
Do NOT repeat what is already written. Do NOT add preamble. Just continue.`},
			{Role: "user", Content: "Continue this:\n\n" + docText},
		},
		"max_tokens": 120,
	})

	req, err := http.NewRequestWithContext(ctx, "POST", a.apiBaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.apiKey)

	resp, err := (&http.Client{Timeout: 25 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	var result struct {
		Choices []struct {
			Message struct{ Content string `json:"content"` } `json:"message"`
		} `json:"choices"`
		Error *struct{ Message string `json:"message"` } `json:"error"`
	}
	if err := json.Unmarshal(b, &result); err != nil {
		return "", err
	}
	if result.Error != nil {
		return "", fmt.Errorf("API: %s", result.Error.Message)
	}
	if len(result.Choices) == 0 {
		return "", fmt.Errorf("no choices")
	}
	return result.Choices[0].Message.Content, nil
}

func (a *Agent) fallbackResponse(docText string) string {
	wc := len(strings.Fields(docText))
	return fmt.Sprintf("(Demo mode — %d words so far. Add LLM_API_KEY to get real AI suggestions.)", wc)
}

// typeText injects characters one at a time, checking for cancellation on each.
// Fractional IDs are anchored to the document's CURRENT last character
// so the AI always appends at the very end, never inside existing text.
func (a *Agent) typeText(ctx context.Context, text string) {
	atomic.StoreInt32(&a.isTyping, 1)
	defer atomic.StoreInt32(&a.isTyping, 0)

	chars := []rune(text)
	n := len(chars)
	if n == 0 {
		return
	}

	// Read live document to find the true last character position
	anchorID := 0.88
	if doc := a.hub.GetDocument(a.roomID); doc != nil {
		existing := doc.GetChars()
		maxID := 0.0
		for _, c := range existing {
			if c.ID > maxID {
				maxID = c.ID
			}
		}
		if maxID > 0 {
			// Place anchor just after the last real char, well before sentinel 1.0
			gap := (1.0 - maxID) * 0.5
			anchorID = maxID + gap
		}
	}

	step := (1.0 - anchorID) / float64(n+2)
	if step <= 0 {
		anchorID = 0.85
		step = 0.15 / float64(n+2)
	}

	for i, ch := range chars {
		select {
		case <-ctx.Done():
			log.Printf("[AGENT] Stopped typing (user resumed)")
			return
		default:
		}

		a.agentTimestamp++

		a.hub.Broadcast(hub.BroadcastMessage{
			RoomID: a.roomID,
			Mutation: crdt.Mutation{
				RoomID:    a.roomID,
				ClientID:  AgentClientID,
				OpType:    "insert",
				CharID:    anchorID + step*float64(i+1),
				Value:     string(ch),
				Timestamp: a.agentTimestamp,
			},
			SenderID:  "",    // empty = deliver to ALL WebSocket clients
			FromAgent: true,  // prevents hub from calling NotifyUpdate (no debounce loop)
		})

		time.Sleep(TypeDelay)
	}

	log.Printf("[AGENT] Finished typing in room %s", a.roomID)
}
