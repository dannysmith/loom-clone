# The CI test job runs in this same image so the deploy gate tests the exact
# toolchain production runs — a bump here must be mirrored in
# .github/workflows/deploy.yml. Pinned versions:
#   bun 1.3.14, Debian 13 (trixie), apt ffmpeg 7.1.x
FROM oven/bun:1.3.14 AS base

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

# Copy all server source.
COPY . .

# Build the editor React app (output goes to public/editor/).
RUN cd editor && bun install --frozen-lockfile && bun run build

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
