FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/watchtower/package.json ./apps/watchtower/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/state-machine/package.json ./packages/state-machine/
COPY packages/sdk/package.json ./packages/sdk/
RUN pnpm install --frozen-lockfile --filter @pico/watchtower...
COPY . .
RUN pnpm --filter @pico/protocol build && \
    pnpm --filter @pico/state-machine build && \
    pnpm --filter @pico/sdk build && \
    pnpm --filter @pico/watchtower build

FROM node:20-alpine
ARG INCLUDE_LITESTREAM=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN if [ "$INCLUDE_LITESTREAM" = "1" ]; then \
      apk add --no-cache curl ca-certificates && \
      curl -fL https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz \
        | tar -xz -C /usr/local/bin litestream ; \
    fi
COPY --from=builder /repo /repo
WORKDIR /repo/apps/watchtower
EXPOSE 3031
CMD ["node", "dist/index.js"]
