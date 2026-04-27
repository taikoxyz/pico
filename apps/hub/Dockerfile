FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/hub/package.json ./apps/hub/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/state-machine/package.json ./packages/state-machine/
COPY packages/sdk/package.json ./packages/sdk/
RUN pnpm install --frozen-lockfile --filter @tainnel/hub...
COPY . .
RUN pnpm --filter @tainnel/hub... build

FROM node:20-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=builder /repo /repo
WORKDIR /repo/apps/hub
EXPOSE 3030 9090
CMD ["node", "dist/server.js"]
