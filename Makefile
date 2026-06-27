# ──────────────────────────────────────────────────────────────────────────────
# Collab Editor — Makefile
# ──────────────────────────────────────────────────────────────────────────────
.PHONY: all backend frontend dev test test-go build-docker clean help

# Default target
all: help

# ── Development ───────────────────────────────────────────────────────────────

## Start the Go backend (requires Go 1.21+)
backend:
	@echo "▶ Starting Go backend on :8080..."
	@cd backend && go run ./main.go

## Start the React frontend (requires Node 18+)
frontend:
	@echo "▶ Starting React frontend on :3000..."
	@cd frontend && npm start

## Start both services concurrently (requires 'make' with job control)
dev:
	@echo "▶ Starting full stack..."
	@$(MAKE) -j2 backend frontend

## Start with Docker Compose (recommended for first run)
dev-docker:
	@echo "▶ Starting with Docker Compose..."
	docker compose up --build

# ── Testing ───────────────────────────────────────────────────────────────────

## Run all Go tests with race detector
test-go:
	@echo "▶ Running Go tests..."
	@cd backend && go test -v -race ./...

## Run frontend tests
test-frontend:
	@echo "▶ Running frontend tests..."
	@cd frontend && npm test -- --watchAll=false

## Run all tests
test: test-go test-frontend

# ── Code Quality ──────────────────────────────────────────────────────────────

## Run Go linter (requires golangci-lint)
lint-go:
	@cd backend && golangci-lint run ./...

## Run TypeScript type check
typecheck:
	@cd frontend && npx tsc --noEmit

# ── Setup ─────────────────────────────────────────────────────────────────────

## Install all dependencies
install:
	@echo "▶ Installing Go dependencies..."
	@cd backend && go mod download
	@echo "▶ Installing Node dependencies..."
	@cd frontend && npm install

# ── Build ─────────────────────────────────────────────────────────────────────

## Build Go binary
build-go:
	@echo "▶ Building Go binary..."
	@cd backend && CGO_ENABLED=0 go build -o bin/collab-editor-server ./main.go
	@echo "✓ Binary: backend/bin/collab-editor-server"

## Build frontend for production
build-frontend:
	@echo "▶ Building React for production..."
	@cd frontend && npm run build
	@echo "✓ Output: frontend/build/"

## Build Docker images
build-docker:
	@echo "▶ Building Docker images..."
	docker compose build

# ── Cleanup ───────────────────────────────────────────────────────────────────

## Remove build artifacts
clean:
	@rm -rf backend/bin frontend/build
	@echo "✓ Cleaned"

## Stop Docker services
stop:
	docker compose down

# ── Help ──────────────────────────────────────────────────────────────────────

## Show this help
help:
	@echo ""
	@echo "  Collab Editor — Development Commands"
	@echo ""
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
