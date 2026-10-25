# Collab Editor — developer commands. Requires Go 1.22+ and Node 22.18+.
.PHONY: help install dev backend frontend build build-go build-web test test-go test-race test-web test-protocol test-e2e \
        test-protocol-go test-e2e-go fuzz bench bench-go docker docker-run clean

GO_BIN := backend/bin/collab-editor-server

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install frontend dependencies (Go has no third-party modules)
	cd frontend && npm install

backend: ## Run the Go server on :8080 (API + WebSocket)
	cd backend && go run .

frontend: ## Run the frontend dev server on :3000 (talks to :8080)
	cd frontend && npm run dev

dev: ## Run backend and frontend together
	$(MAKE) -j2 backend frontend

build-go: ## Build the Go binary
	cd backend && CGO_ENABLED=0 go build -o bin/collab-editor-server .

build-web: ## Build the frontend into frontend/dist
	cd frontend && npm run build

build: build-go build-web ## Build both

test: test-go test-web test-protocol test-e2e ## Everything (Go + TS + conformance + browser, TS test server)

test-go: ## Go vet + unit/integration tests
	cd backend && test -z "$$(gofmt -l .)" && go vet ./... && go test ./...

test-race: ## Go tests with the race detector and coverage
	cd backend && go test -race -cover ./...

fuzz: ## Short fuzz run of the CRDT
	cd backend && go test -run='^$$' -fuzz=FuzzApply -fuzztime=30s ./crdt

test-web: ## Typecheck + frontend unit tests
	cd frontend && npm run typecheck && npm test

test-protocol: ## Protocol conformance suite against the TS test server
	cd frontend && npm run test:protocol

test-e2e: ## Playwright E2E against the TS test server
	cd frontend && npx playwright test

# ── same suites against the Go server ────────────────────────────────────────
test-protocol-go: build-go ## Conformance suite against the Go server
	@PORT=8091 $(GO_BIN) & PID=$$!; trap "kill $$PID" EXIT; sleep 1; \
	cd frontend && SERVER_URL=http://127.0.0.1:8091 node tests/protocol/run.mjs

test-e2e-go: build ## Playwright E2E against the Go server (+ fake LLM)
	@cd frontend && (FAKE_LLM_PORT=8299 node e2e/fake-llm.mjs & echo $$! > /tmp/fake-llm.pid); \
	PORT=8092 STATIC_DIR=frontend/dist LLM_API_KEY=e2e LLM_MODEL=fake LLM_API_URL=http://127.0.0.1:8299 AI_TIMEOUT_MS=2500 $(GO_BIN) & PID=$$!; \
	trap "kill $$PID $$(cat /tmp/fake-llm.pid)" EXIT; sleep 1; \
	cd frontend && E2E_BASE_URL=http://127.0.0.1:8092 npx playwright test

bench: ## CRDT + WebSocket benchmarks (TS server) → scripts/benchmarks/results
	node scripts/benchmarks/crdt-bench.ts
	node scripts/benchmarks/ws-latency.ts
	cd frontend && npm run build && node bench/browser-bench.mjs

bench-go: build-go ## Go micro-benchmarks + WebSocket benchmark against the Go server
	cd backend && go test -run='^$$' -bench=. -benchmem ./crdt
	@PORT=8093 $(GO_BIN) & PID=$$!; trap "kill $$PID" EXIT; sleep 1; \
	SERVER_URL=http://127.0.0.1:8093 SERVER_PID=$$PID node scripts/benchmarks/ws-latency.ts

docker: ## Build the production image
	docker build -t collab-editor .

docker-run: docker ## Run the production image on :8080
	docker run --rm -p 8080:8080 collab-editor

clean:
	rm -rf backend/bin frontend/dist frontend/test-results frontend/playwright-report
