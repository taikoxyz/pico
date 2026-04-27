# P7 — Wallet UI

**Status:** 🔵 not started — page shells exist (`/`, `/open`, `/pay`, `/dvm`,
`/settings`), Tailwind set up, no wagmi/SDK wiring yet
**Blocks:** P10 (only the user-facing path; CLI can substitute for testing)
**Effort:** ~1 week
**Depends on:** P4 (SDK)
**Parallelizable with:** P5, P6 once P4 is enough to mock against

## Decisions

### D7.1 Wallet connector(s)
- **Default:** **WalletConnect** via wagmi v2's `walletConnect` connector +
  injected (MetaMask). The dogfood crowd is technical; both work.
- **Tradeoff:** WalletConnect needs a project ID from cloud.walletconnect.com
  (free for dev). Skipping it means MetaMask-only.
- Decision: ☐ MetaMask + WalletConnect ☐ MetaMask only

### D7.2 Storage in browser
- **Default:** `IndexedDBStorage` from the SDK
- Decision: ☐ accept default

### D7.3 Hosting
- **Default:** Cloudflare Pages (free, zero-config from the `dist/` output)
- **Tradeoff:** Vercel is the default React deploy but adds env complexity.
  Cloudflare Pages is the same shape and stays inside one account.
- Decision: ☐ Cloudflare Pages ☐ Vercel ☐ Netlify ☐ self-host

### D7.4 Visual polish bar
- **Default:** **functional ugly is fine for v1.** Plain Tailwind, no shadcn
  components beyond what's already scaffolded, no animations.
- **Tradeoff:** Prettier UI is nice but eats time. The dogfood scope justifies
  ugly-but-correct.
- Decision: ☐ functional ☐ polish pass before launch

### D7.5 Hub configuration
- **Default:** the production hub URL is hardcoded (in `src/config.ts` from
  env at build time). User can override in `/settings`.
- Decision: ☐ accept default

## Implementation tasks

### Wagmi setup (`src/wagmi.ts`)
- [ ] `[agent]` Configure `wagmi` with Taiko mainnet and Hoodi chains, the chosen
      connectors, and `viem` HTTP transports pointing at public RPCs.
- [ ] `[agent]` Wrap the app in `WagmiProvider` + `QueryClientProvider`
      (`@tanstack/react-query`).

### `src/sdk-context.tsx` (new file)
- [ ] `[agent]` Provider that creates a `ChannelClient` with:
      - `wallet`: a viem-wallet-adapter built from wagmi's `useWalletClient()`
      - `transport`: `WebSocketTransport` to the configured hub URL
      - `storage`: `IndexedDBStorage`
- [ ] `[agent]` `useChannelClient()` hook for components.

### Pages

#### `/` Dashboard
- [ ] `[agent]` Show: connected address (truncated), each channel's id, status,
      our balance, counterparty balance, pending HTLCs.
- [ ] `[agent]` "Refresh" button that re-reads from storage.
- [ ] `[agent]` Empty state: "You don't have any channels yet. Open one →".

#### `/open` Open channel
- [ ] `[agent]` Form: amount in USDC (with conversion to bigint at 6 decimals),
      hub URL (defaulted), submit.
- [ ] `[agent]` Calls `client.open()`. Show progressive states: approving USDC,
      waiting for tx, waiting for hub ack, channel opened.
- [ ] `[agent]` On success, redirect to `/`.

#### `/pay` Pay
- [ ] `[agent]` Form: recipient EVM address, amount in USDC, optional memo,
      "Pay" button.
- [ ] `[agent]` Calls `client.pay({to, amount})`. Show: HTLC sent, awaiting
      preimage, settled.
- [ ] `[agent]` Error states: insufficient channel balance, recipient
      unreachable, hub timeout.

#### `/dvm` DVM browser
- [ ] **Out of scope for v1.** Leave as a "Coming in Phase 2" placeholder. Don't
      delete; the page exists to anchor the route.

#### `/settings`
- [ ] `[agent]` Hub URL override, watchtower URL override (read-only display
      since users don't pick their watchtower in v1), version info, "Export
      state" button (downloads JSON of current sqlite/IndexedDB).

### Build + deploy
- [ ] `[agent]` Add `pnpm --filter @tainnel/wallet-ui build` env handling
      (`VITE_HUB_URL`, `VITE_TAIKO_CHAIN_ID`, `VITE_PAYMENT_CHANNEL_ADDRESS`).
- [ ] `[agent]` Wire to chosen hosting platform (Cloudflare Pages: connect repo,
      build command `pnpm --filter @tainnel/wallet-ui build`, output
      `apps/wallet-ui/dist`).

### Tests
- [ ] `[agent]` Smoke: app boots, all five routes render without crash. (Use
      `@testing-library/react` + a minimal mock SDK context.)
- [ ] `[agent]` E2E with Playwright: open → pay → close happy path against the
      mock hub from `@tainnel/test-utils`. Optional, recommend yes.

## `[review]` gates

- You manually run through open → pay → close at least once on Hoodi before
  P10 mainnet launch. The wallet UI is the user-facing failure surface; if
  anything's confusing, fix it now.

## Done when

- All `[ ]` boxes checked
- Manually tested on Hoodi by Daniel
- Deployed to staging URL (preview branch)
- Branch merged with `feat(wallet-ui): implement open/pay/close flows`
