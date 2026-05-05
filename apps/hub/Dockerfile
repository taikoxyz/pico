FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/hub/package.json ./apps/hub/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/state-machine/package.json ./packages/state-machine/
COPY packages/sdk/package.json ./packages/sdk/
RUN pnpm install --frozen-lockfile --filter @pico/hub...
COPY . .
RUN pnpm --filter @pico/protocol build && \
    pnpm --filter @pico/state-machine build && \
    pnpm --filter @pico/sdk build && \
    pnpm --filter @pico/hub build

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
WORKDIR /repo/apps/hub
EXPOSE 3030 9090
CMD ["node", "dist/server.js"]
