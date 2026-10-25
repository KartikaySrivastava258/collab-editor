# Single image: Go server + built frontend, served from one origin.
#   docker build -t collab-editor .
#   docker run -p 8080:8080 collab-editor          → http://localhost:8080

# ── 1. frontend ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
# Uses the lockfile when present (see docs/KNOWN_LIMITATIONS.md: lockfile).
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY frontend/ ./
RUN npm run build

# ── 2. backend ───────────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS go
WORKDIR /src
COPY backend/go.mod ./
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/collab-editor-server .

# ── 3. runtime: distroless, non-root, no shell ──────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=go /out/collab-editor-server /app/collab-editor-server
COPY --from=web /web/dist /app/public
ENV PORT=8080 STATIC_DIR=/app/public LOG_FORMAT=json
EXPOSE 8080
USER nonroot:nonroot
HEALTHCHECK --interval=10s --timeout=4s --start-period=5s --retries=3 CMD ["/app/collab-editor-server", "healthcheck"]
ENTRYPOINT ["/app/collab-editor-server"]
