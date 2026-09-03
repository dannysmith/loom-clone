# The CI test job runs in this same image so the deploy gate tests the exact
# toolchain production runs — a bump here must be mirrored in
# .github/workflows/deploy.yml. Digest-pinned so the tag can't drift
# underneath us. Pinned versions:
#   bun 1.3.14, Debian 13 (trixie), apt ffmpeg 7.1.x
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS base

# --- Admin client build stage ---
# Builds the admin React apps (editor + cover tool) in their own stage so the
# toolchain (React, Vite, wavesurfer — all of admin-client/node_modules) never
# reaches the runtime image, and so server source changes don't invalidate the
# admin-client layers (and vice versa). CI also builds it as a check
# (deploy.yml), but this build is the one production actually serves.
FROM base AS admin-client-build
WORKDIR /build/admin-client
COPY admin-client/package.json admin-client/bun.lock ./
RUN bun install --frozen-lockfile
COPY admin-client/ ./
# vite.config.ts outDir is ../public/admin-client → /build/public/admin-client
RUN bun run build

# --- Runtime image ---
FROM base AS runtime

# ffmpeg comes from Debian stable, so it only moves within 7.1.x point releases
# while the base image stays pinned. The audio chain (arnndn/afftdn/loudnorm)
# and `-fps_mode passthrough` depend on ffmpeg behaviour — the major-version
# assertion below fails the build if a base-image bump silently changes it.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*
RUN ffmpeg -version | head -1 && \
    ffmpeg -version | head -1 | grep -q "ffmpeg version 7\." || \
    { echo "ffmpeg major version drifted from the pinned 7.x — retest the media pipeline before accepting"; exit 1; }

WORKDIR /app

# Install server dependencies.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy all server source (admin-client/player node_modules and
# public/admin-client are excluded via .dockerignore; their sources are copied
# but never installed).
COPY . .

# Bring in the built admin-client assets.
COPY --from=admin-client-build /build/public/admin-client ./public/admin-client

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
