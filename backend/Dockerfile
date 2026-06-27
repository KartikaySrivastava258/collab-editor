# ── Stage 1: Build ─────────────────────────────────────────────────────────────
# Pure stdlib — no external Go dependencies to download.
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Copy module file first (layer cache: only re-runs if go.mod changes)
COPY go.mod ./

# Copy source and build a statically-linked binary
# CGO_ENABLED=0 produces a self-contained binary that runs in distroless
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-w -s" \
    -o /app/collab-editor-server \
    ./main.go

# ── Stage 2: Runtime ───────────────────────────────────────────────────────────
# Distroless: no shell, no package manager — minimal attack surface.
# The binary is statically linked so it runs without any libc.
FROM gcr.io/distroless/static-debian12

COPY --from=builder /app/collab-editor-server /collab-editor-server

EXPOSE 8080

ENTRYPOINT ["/collab-editor-server"]
