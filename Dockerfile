# Stage 1: Build TypeScript and prune dev dependencies
FROM node:22-slim AS builder

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for tsc)
# Skip Puppeteer's bundled Chromium download — not needed at build time
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

# Copy TypeScript config and source
COPY tsconfig.json tsconfig.visualizer.json ./
COPY src/ ./src/

# Compile TypeScript to dist/
RUN npm run build

# Remove devDependencies from node_modules
RUN npm prune --omit=dev


# Stage 2: Minimal runtime image
FROM node:22-slim

# Install system prerequisites:
#   tmux       — terminal multiplexer for multi-pane daemon
#   jq         — JSON processing in bash scripts
#   git        — used by agent workspaces
#   procps     — provides pgrep/pkill for process management
#   cron       — used by the schedule skill
#   chromium   — headless browser for whatsapp-web.js (via Puppeteer)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tmux \
        jq \
        git \
        procps \
        cron \
        chromium \
    && rm -rf /var/lib/apt/lists/*

# Add corporate root CA (Cisco Umbrella) for TLS verification behind proxy
COPY certs/cisco-umbrella-root-ca.pem /usr/local/share/ca-certificates/cisco-umbrella-root-ca.crt
RUN update-ca-certificates

# Point Node.js to the corporate root CA
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/cisco-umbrella-root-ca.crt

# Tell Puppeteer to use the system Chromium instead of downloading its own
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Claude Code CLI (Anthropic provider) and Codex CLI (OpenAI provider)
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /app

# Copy production node_modules and compiled output from builder
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/dist ./dist/

# Copy runtime files from source context
COPY package.json ./
COPY bin/ ./bin/
COPY tinyclaw.sh ./
COPY lib/ ./lib/
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY .agents/ ./.agents/
COPY AGENTS.md SOUL.md heartbeat.md ./

# Make all shell scripts executable
RUN chmod +x bin/tinyclaw tinyclaw.sh \
    && find lib/ scripts/ -name '*.sh' -exec chmod +x {} +

# Create non-root user (Claude Code CLI refuses --dangerously-skip-permissions as root)
# Pre-create volume directories and seed default settings
RUN useradd -m -s /bin/bash -u 1001 tinyclaw \
    && mkdir -p /home/tinyclaw/.tinyclaw /home/tinyclaw/tinyclaw-workspace
COPY config/settings.json /home/tinyclaw/.tinyclaw/settings.json

# Copy pre-built agent workspaces with custom SOUL.md and templates
# This MUST happen BEFORE the VOLUME directive so data seeds the volume on first run
COPY workspaces/ /tmp/workspaces/
RUN for agent in lead architect developer reviewer qa designer writer; do \
        target="/home/tinyclaw/tinyclaw-workspace/$agent"; \
        mkdir -p "$target/.claude" "$target/.tinyclaw" "$target/.agent"; \
        cp -a /tmp/workspaces/$agent/. "$target/"; \
        ln -sf /app/.agents/skills "$target/.claude/skills"; \
        ln -sf /app/.agents/skills "$target/.agent/skills"; \
    done \
    && rm -rf /tmp/workspaces

# Set ownership for all tinyclaw user directories
RUN chown -R tinyclaw:tinyclaw /app /home/tinyclaw

# Prevent accidental Chromium downloads if npm install runs at runtime
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Data directory for settings, queue, logs, and channel state
ENV TINYCLAW_HOME=/home/tinyclaw/.tinyclaw

# Add tinyclaw CLI to PATH
ENV PATH="/app/bin:${PATH}"

# Declare volumes for persistent data
VOLUME ["/home/tinyclaw/.tinyclaw", "/home/tinyclaw/tinyclaw-workspace"]

# Switch to non-root user
USER tinyclaw

ENTRYPOINT ["tinyclaw"]
CMD ["start"]
