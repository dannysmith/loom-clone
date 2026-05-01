FROM oven/bun:1 AS base

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

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
