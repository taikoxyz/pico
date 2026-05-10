# Pico hub — what actually happens in each scenario

A walk-through of every meaningful state transition in the pico v1 protocol,
separated into **on-chain** and **off-chain** actions. Use this as a ground-truth
companion to [`protocol-spec.md`](./protocol-spec.md) when reasoning about a
particular flow.

Notation:

- 🟦 **OFF-CHAIN** — pure message passing or local DB write, no gas, no tx.
- 🟧 **ON-CHAIN** — a transaction that pays gas and changes contract state.
- "**state**" with a number means a *channel state*: an off-chain object
  `{ channelId, version, balanceA, balanceB, htlcsRoot }`.
- The SDK constructs a `version: 1` state at open time, signed only by the
  opener; the hub trusts it because it matches the on-chain `ChannelOpened`
  event. This sigA-only state remains until either (a) the channel sees its
  first balance shift (off-chain payDirect or HTLC) producing a co-signed
  `version: 2`, or (b) a `topUp` runs, which **overwrites** the local
  `version: 1` with a fully co-signed one carrying the post-topUp balances.
- From `version: 2` onward (or after a `topUp`'s upgraded `version: 1`), every
  state is co-signed by both parties because it asserts balances or amounts
  not anchored on-chain.
- USDC amounts are 6-decimal base units; written as decimal USDC for clarity.

Three actors throughout:

| Actor | Role |
|---|---|
| **Alice** | Sender. Opens a one-sided channel, pays Bob through the hub. |
| **Bob** | Receiver. Needs **inbound liquidity** from the hub. |
| **Hub** (`hub.pico.taiko.xyz`) | Long-running off-chain service + on-chain hot wallet. Co-signs channel state, routes payments, provisions inbound liquidity via `topUp`. |

The contract that holds funds: **PaymentChannel.sol**. It has a mapping
`channels[channelId] = { userA, userB, token, amountA, amountB, status, … }`. When a
channel opens, USDC is transferred *into* the contract; when it closes, USDC is paid
*out* of the contract. `topUp` is an additive deposit during the channel's life.

---

## Scenario 1 — Alice opens a one-sided channel to the hub

**Goal:** Alice deposits 10 USDC so she can spend off-chain through the hub.

**Pre-state:** Alice has 10 USDC in her wallet, 0 USDC in any channel.

### Steps

1. 🟧 **ON-CHAIN — Alice approves PaymentChannel for USDC.**
   `cast send USDC "approve(PaymentChannel, 10_000_000)"`. Pure ERC-20 allowance.

2. 🟧 **ON-CHAIN — Alice calls `openChannel(hub, USDC, 10, 0)`.**
   - Contract pulls 10 USDC from Alice via `safeTransferFrom`.
   - Contract pulls 0 USDC from hub.
   - Contract writes `channels[id] = { userA=Alice, userB=Hub, amountA=10, amountB=0 }`.
   - Emits `ChannelOpened(id, Alice, Hub, USDC, 10, 0)`.

3. 🟦 **OFF-CHAIN — Alice's SDK constructs the initial state (version 1).**
   `state1 = { channelId=id, version=1, balanceA=10, balanceB=0, htlcs=[] }`.
   See `packages/sdk/src/client.ts:203-222`. Alice signs `sigA`. The hub's slot
   `sigB` is `ZERO_SIG`. Saved to her local SQLite.

4. 🟦 **OFF-CHAIN — Alice connects to hub via WS, sends `subscribe`.**
   `{ kind: "subscribe", address: Alice, channelIds: [id] }`. Hub replies with
   `subscribeAck`.

5. 🟦 **OFF-CHAIN — Hub's chain-watcher independently picks up `ChannelOpened`.**
   `apps/hub/src/chain-watcher.ts:238` updates the channel status. The hub's
   view of state version 1 is derived from on-chain `amountA`/`amountB`.

**Post-state:**

- On-chain: contract holds 10 USDC. `channels[id] = { Alice, Hub, 10, 0 }`.
- Off-chain: Alice holds `state1 { 10, 0 }` (Alice-signed). Hub trusts the
  on-chain amounts.
- **Liquidity meaning:** Alice has 10 USDC of *outbound*. Hub has 0 USDC of
  outbound in this channel.

---

## Scenario 2 — Alice pays the hub directly (`payDirect` 1 USDC)

**Goal:** Alice transfers 1 USDC of value to the hub. No second hop.

**Pre-state:** state1 = `{A:10, B:0}` (Alice-signed only).

### Steps

1. 🟦 **OFF-CHAIN — Alice signs state2.**
   `state2 = { version=2, balanceA=9, balanceB=1, htlcsRoot=0 }`. Sends `payDirect`
   over WS with sigA.

2. 🟦 **OFF-CHAIN — Hub validates and co-signs.**
   - Conservation `9+1 == 10+0` ✓
   - Monotonicity `version 2 > 1` ✓
   - Alice's sig ✓
   - This is the first state requiring both sigs. Hub adds sigB. Returns fully
     co-signed state2.

3. 🟦 **OFF-CHAIN — both store state2.** state1 is now stale but kept for dispute.

**Post-state:**

- On-chain: **unchanged**. `channels[id]` is the same.
- Off-chain: state2 = `{9, 1}`, **co-signed**. Alice's claim is now 9; hub's is 1.

---

## Scenario 3 — Bob opens a one-sided channel

Identical mechanics to Scenario 1, but for Bob.

**Post-state:**

- On-chain: a separate channel `idB`, `channels[idB] = { Bob, Hub, 10, 0 }`. Contract
  holds 20 USDC total.
- Off-chain: Bob holds `stateB1 = {10, 0}` (Bob-signed only).
- **Liquidity meaning:** Bob has 10 USDC outbound. **Hub has 0 USDC outbound in
  Bob's channel.** This is the gap.

---

## Scenario 4 — Alice tries to pay Bob via the hub (FAILS without top-up)

**Pre-state:** Scenarios 1–3. Alice's state2 = `{9, 1}` (co-signed). Bob's
stateB1 = `{10, 0}` (Bob-signed).

### Steps

1. 🟦 **OFF-CHAIN — Alice constructs a `pay` HTLC offer state.**
   `state3A = { v=3, A=8, B=1, htlcsRoot=hash([{H, 1USDC, recipient=Bob}]) }`.

2. 🟦 **OFF-CHAIN — Hub receives `pay`, attempts to route.**
   `apps/hub/src/router.ts:77` finds Bob's channel `idB`.

3. 🟦 **OFF-CHAIN — Router checks outbound liquidity.**
   `hubBalance = stateB1.balanceB = 0`. `0 < 1` → **router throws**:
   `"router: hub liquidity 0 < outgoing amount 1 on idB"`.

4. 🟦 **OFF-CHAIN — Hub replies `paymentFailed`.** Alice's state3A was never
   co-signed; it's discarded. Effective state remains state2.

**This is the gap that `topUp` (Scenario 5) closes.**

---

## Scenario 5 — Hub auto-tops-up Bob's channel (the new flow)

**Goal:** Hub provides 5 USDC of outbound liquidity in Bob's channel so Bob can
receive routed payments.

**Pre-state:** Bob's channel `idB` exists with `amountB = 0`. Hub has USDC + ETH
in its hot wallet. Hub has approved PaymentChannel for at least 5 USDC.

### Steps

1. 🟦 **OFF-CHAIN — Hub's chain-watcher fires on `ChannelOpened`.**
   It enqueues a top-up evaluation for Bob's address.

2. 🟦 **OFF-CHAIN — Hub admission policy.**
   - Per-counterparty cap: `intendedAmountB (5) ≤ HUB_MAX_INBOUND_PER_COUNTERPARTY` ✓
   - No existing larger hub→Bob outbound elsewhere ✓
   - Hub hot-wallet USDC available ≥ 5 ✓
   - Decision: top up by 5 USDC.

3. 🟦 **OFF-CHAIN — Hub WS-pushes `proposeTopUp` to Bob.**

   ```
   {
     kind: "proposeTopUp",
     channelId: idB,
     offerId: 0xabc...123,
     amount: 5_000_000,
     prevStateVersion: 0,                  // freshly opened, no co-signed state yet
     newState: {
       channelId: idB, version: 1, balanceA: 10, balanceB: 5, htlcsRoot: 0, finalized: false
     },
     validUntil: now + 5min,
     feePolicy: null,                      // free inbound for this scenario
     minLifetime: null,
     maxInFlightHtlcs: 5,
     partialAccepted: false,
     prevSig: ZERO_SIG,                    // sentinel: implicit on-chain initial state
     newSig: <hub's signature on newState>
   }
   ```

4. 🟦 **OFF-CHAIN — Bob's SDK validates and signs.**
   - Channel matches; `prevStateVersion=0` consistent with Bob's local
     "no-co-signed-state-yet" ✓
   - `validUntil` not yet past ✓
   - `newState`: balanceA unchanged (10), balanceB increased by exactly amount
     (0 → 5), version 1, htlcsRoot 0 ✓
   - Hub's `newSig` recovers to hub's address ✓
   - Bob signs `newState` with sigA. Returns `acceptTopUp { channelId, offerId, signedNewState }`.

5. 🟧 **ON-CHAIN — Hub calls `topUp(idB, 5_000_000, prevState=sentinel, newState=signedState)`.**
   - `require(channels[idB].status == open)` ✓
   - `require(msg.sender == userB)` ✓ (hub is Bob's userB)
   - **prevState** is the sentinel `(version=0, balanceA=amountA=10, balanceB=amountB=0,
     htlcsRoot=0, finalized=false, sigA=ZERO_SIG, sigB=ZERO_SIG)`. Contract
     accepts the sentinel without signature checks because no off-chain co-signed
     state exists yet (§8.3 step 3).
   - **newState** validation: version=1, balanceB increased by 5, balanceA
     unchanged, htlcsRoot=0, both sigs verify ✓
   - Conservation against new amounts: `10+5 == 10+0+5` ✓
   - `safeTransferFrom(hub, contract, 5)` — pulls 5 USDC from hub
   - `channels[idB].amountB += 5` → 5
   - Posted state snapshot ← newState (postedVersion=1)
   - Emits `ToppedUp(idB, hub, 5, 1)`.

6. 🟦 **OFF-CHAIN — Bob's chain-watcher / hub's chain-watcher both observe `ToppedUp`.**
   Internal state confirms the topUp landed.

**Post-state:**

- On-chain: contract holds 25 USDC total. `channels[idB] = { Bob, Hub, 10, 5 }`,
  posted state `version=1`, `postedBalanceA=10`, `postedBalanceB=5`.
- Off-chain: Bob and hub both hold co-signed `stateB1 = {10, 5, v=1}`. The
  earlier opener-only sigA-only stateB1 from Scenario 3 is overwritten — same
  version, but now both sigs and the new balances reflecting the topUp.
- **Hub now has 5 USDC of outbound in Bob's channel.** Routing to Bob will succeed.

---

## Scenario 6 — Alice pays Bob 1 USDC via hub (NOW WORKS)

**Pre-state:** Alice's state2 = `{9, 1, v=2}` (co-signed). Bob's stateB1 = `{10, 5, v=1}`
(co-signed via Scenario 5's topUp).

### Steps

1. 🟦 **OFF-CHAIN — Alice creates an HTLC offer state.**
   `state3A = { v=3, A=8, B=1, htlcsRoot=hash([{H, 1USDC, recipient=Bob}]) }`.
   Alice signs sigA, sends `pay`.

2. 🟦 **OFF-CHAIN — Hub validates incoming HTLC.**
   Conservation `8+1+1 == 10+0` ✓. Records pending state. Routes.

3. 🟦 **OFF-CHAIN — Router finds Bob's channel and checks outbound.**
   `hubBalance = stateB1.balanceB = 5`. `5 ≥ 1` ✓.

4. 🟦 **OFF-CHAIN — Hub creates HTLC offer on Bob's channel.**
   `stateB2 = { v=2, A=10, B=4, htlcsRoot=hash([{H, 1USDC}]) }`. Hub signs sigB,
   sends to Bob. Bob counter-signs sigA.

5. 🟦 **OFF-CHAIN — Bob settles by revealing preimage P.**
   `htlcSettle{P}` to hub. Hub verifies `sha256(P) == H`.

6. 🟦 **OFF-CHAIN — Bob's channel resolves the HTLC.**
   `stateB3 = { v=3, A=11, B=4, htlcsRoot=0 }`. Both sign.

7. 🟦 **OFF-CHAIN — Hub forwards preimage upstream to Alice.**
   Hub co-signs the resolved state for Alice's channel.

8. 🟦 **OFF-CHAIN — Alice's channel resolves.**
   `state4A = { v=4, A=8, B=2, htlcsRoot=0 }`. Both sign.

**Post-state:**

- On-chain: **unchanged**.
- Off-chain:
  - Alice's channel: A=8, B=2.
  - Bob's channel: A=11, B=4.
- **Net value flow: Alice −1, Bob +1, Hub net 0.**

---

## Scenario 7 — Cooperative close of both channels

The `CooperativeClose` artifact is bound to a **state version** and a
**validUntil** deadline (§6.2 of the spec). The contract enforces:
`version > channels[id].postedVersion` and `block.timestamp ≤ validUntil`.

### Alice's channel

1. 🟦 **OFF-CHAIN — Alice and hub sign**
   `CooperativeClose { channelId=idA, version=4, finalBalanceA=8, finalBalanceB=2, signedAt=now, validUntil=now+1h }`.
   The `version=4` matches Alice's latest co-signed state (state4A from Scenario 6
   step 8). Alice's channel `postedVersion` is still 0 (no on-chain state was
   ever posted), so `4 > 0` ✓.
2. 🟧 **ON-CHAIN — `closeCooperative(...)`.**
   - `version (4) > postedVersion (0)` ✓
   - `block.timestamp ≤ validUntil` ✓
   - Conservation `8+2 == 10+0` ✓
   - Pays 8 USDC to Alice, 2 USDC to hub.
   - Sets `status = Closed`.

### Bob's channel

3. 🟦 **OFF-CHAIN — Bob and hub sign**
   `CooperativeClose { channelId=idB, version=3, finalBalanceA=11, finalBalanceB=4, signedAt=now, validUntil=now+1h }`.
   Bob's channel `postedVersion = 1` (from the topUp in Scenario 5), so `3 > 1` ✓.
4. 🟧 **ON-CHAIN — `closeCooperative(...)`.**
   - `version (3) > postedVersion (1)` ✓
   - Conservation `11+4 == 10+5` ✓ (against post-top-up amounts)
   - Pays 11 USDC to Bob, 4 USDC to hub.

**Why `version` and `validUntil` matter — replay defense in action.**

Suppose Alice and Hub had previously signed an *unsubmitted* close at
`version=2, finalA=9, finalB=1` (right after Scenario 2's payDirect, before the
HTLC routing in Scenario 6). After Scenario 6, the latest co-signed state is
`version=4 {8, 2}`. Without the version binding, the old close `{9, 1}` could
still be posted on-chain because conservation `9+1 == 10+0` is satisfied — and
that would erase the 1 USDC that Alice paid Bob via the HTLC. With the version
binding, the contract rejects the old close because once the new `{8, 2}` close
has been processed (`postedVersion → 4`), any future submission requires
`version > 4`. And if neither close is submitted, `validUntil` ensures stale
authorizations expire on their own.

**Post-state ledger:**

- Alice's wallet: started with 10, deposited 10, got back 8. **Net −2 USDC** (1
  direct-pay to hub + 1 to Bob).
- Bob's wallet: started with 10, deposited 10, got back 11. **Net +1 USDC**.
- Hub's wallet: deposited 5 (topUp), got back 2 (Alice's) + 4 (Bob's) = 6.
  **Net +1 USDC** (the value Alice paid directly in Scenario 2).

---

## Scenario 8 — Hub recovers liquidity (no special call needed)

The hub recovers its `topUp` liquidity automatically when channels close. Each
cooperative close (Scenario 7) returns the hub's `balanceB` (post-payment) to
the hub's hot wallet.

For mid-channel recall without closing, see §8.9 of [`protocol-spec.md`](./protocol-spec.md)
— `spliceOut` is deferred to v1.5.

---

## Scenario 9 — Drain attempts (not possible by construction)

Two attack classes that would have applied to an earlier (segregated-balance)
design are **eliminated by construction** in the topUp model:

### 9.1 — Attacker tries to drain via standard `openChannel`

Attacker calls `openChannel(hub, USDC, 0, 50_000_000)`. Contract attempts
`safeTransferFrom(hub, contract, 50_000_000)`. **Hub never grants any
PaymentChannel allowance for the standard open path.** The hub only approves
PaymentChannel for the specific top-up amount immediately before submitting
each `topUp` tx, and `topUp` only credits `msg.sender`'s own side. Allowance
remains 0 between top-ups, so the standard open path can't pull hub funds.

### 9.2 — Attacker calls `topUp` against the hub

`topUp` requires `msg.sender == userA || msg.sender == userB`. Even if an
attacker is one of those, the contract only credits `msg.sender`'s own side.
There is no path where calling `topUp` causes the contract to pull funds
from the *other* party.

**No replay nonces, no signature freshness, no expiring auths required** —
the security follows from "msg.sender pays for their own deposit" and "both
parties must co-sign the new state."

---

## Scenario 10 — User declines or never returns a `proposeTopUp`

Hub sends `proposeTopUp` with hub-signed sigB. User's CLI is offline, or
explicitly returns `rejectTopUp`.

1. 🟦 **OFF-CHAIN — No `acceptTopUp` arrives within hub's TTL** (e.g. 5 minutes).
2. 🟦 **OFF-CHAIN — Hub clears the in-flight commitment**, frees the 5 USDC for
   another channel.
3. 🟧 **ON-CHAIN — nothing happens.** Hub never submitted the topUp tx. Hub's
   sigB on the unsubmitted state is harmless (the contract requires *both* sigs;
   the user never signed sigA).

User's channel remains at `amountB = 0`. They can request inbound again later
(e.g., by reconnecting), or open a new channel.

---

## Scenario 11 — Unilateral close from initial state (anti-hostage)

**Goal:** Show that a user is never trapped by a non-cooperative hub. Even with
no co-signed state in hand, the user can recover their full deposit on-chain
via `closeUnilateralFromOpen` (§5.2 of the spec).

**Pre-state:** Bob opened a 10 USDC channel (Scenario 3) but the hub has not
sent any `proposeTopUp` and refuses to co-sign any state. Bob holds only the
local opener-signed `stateB1 v=1 {10, 0}` with sigB = ZERO_SIG. Without the
close-from-open path, Bob's funds would be stranded indefinitely.

### Steps

1. 🟧 **ON-CHAIN — Bob calls `closeUnilateralFromOpen(idB)`.**
   - `require(channels[idB].status == open && postedVersion == 0)` ✓
   - Contract synthesizes the implicit initial state from on-chain amounts:
     `{version=0, balanceA=10, balanceB=0, htlcsRoot=0, finalized=false}`.
   - Records `(state, deadline = now + 24h)`.
   - Sets `status = ClosingUnilateral`. Bob is recorded as `closer`.

2. ⏳ **DISPUTE WINDOW (24 hours):** the hub may submit a strictly-newer
   dual-signed state via `dispute(...)` to challenge. Bob has no such state
   (he held only sigA-only stateB1). The hub also has no such state because
   it never co-signed anything. So no challenge is possible.

3. 🟧 **ON-CHAIN — After 24h, anyone calls `finalize(idB)`.**
   - Disburses 10 USDC to Bob, 0 USDC to hub.
   - Sets `status = Closed`.

**Post-state:**

- Bob fully recovers his 10 USDC deposit. Net change: zero (minus gas).
- Hub gained nothing, lost nothing (it never deposited).

**Why this matters:** without `closeUnilateralFromOpen`, a malicious or
unresponsive hub could permanently freeze a user's deposit by simply refusing
to co-sign any `version ≥ 2` state. This was a P0 safety gap in an earlier
draft of the spec; it's closed by the dedicated entry point.

### Race: topUp in flight while user is closing

If the hub had a `topUp` tx in flight while Bob calls `closeUnilateralFromOpen`,
the on-chain ordering is decisive:

- If `topUp` confirms first: channel transitions to a state with `amountB=5`
  and `postedVersion=1`. Bob's subsequent `closeUnilateralFromOpen` would
  revert (`postedVersion != 0`). Bob would need a co-signed state to close
  unilaterally, OR a cooperative close with the hub.
- If `closeUnilateralFromOpen` confirms first: channel is `ClosingUnilateral`.
  The hub's `topUp` reverts (`status != open`). Hub's USDC is not pulled. No loss.

Both outcomes are safe: the channel ends up in a single, well-defined state.

---

## Scenario 12 — Concurrent top-up requests across channels

Hub has 5 USDC headroom in its hot wallet (per its policy). Two new channels
open near-simultaneously; both qualify for a 5 USDC top-up.

### Steps

1. 🟦 **OFF-CHAIN — Hub's WS dispatcher takes a mutex on `(hub, USDC)`** before
   evaluating policy. (Existing `apps/hub/src/mutex.ts` primitive.)

2. 🟦 **OFF-CHAIN — First request wins the lock.** Hub commits 5 USDC, proposes
   topUp, releases lock.

3. 🟦 **OFF-CHAIN — Second request acquires the lock.** Hub computes available =
   0 (5 already committed in flight). Sends `proposeTopUp` with `amount=0`, or
   skips entirely. Channel remains at `amountB=0` until liquidity returns from
   another channel close.

No on-chain conflict — the contract serializes by default since each tx is
ordered. The mutex prevents the hub from double-promising liquidity it doesn't
have.

---

## Scenario 13 — Inbound auto-recycle on close

**Goal:** Show how a conformant hub recycles capital from a closing channel into
a freshly-opened or under-provisioned one, without an intermediate idle period.
This is the behavior specified in §8.8 of [`protocol-spec.md`](./protocol-spec.md).

**Pre-state:**

- Bob's channel `idB` is closing cooperatively with `finalBalanceB = 4` USDC
  (hub side).
- A new user Carol has just opened a channel `idC = { Carol, Hub, 10, 0 }`.
  Carol's `proposeTopUp` was queued by the hub's policy because the hub's
  hot-wallet headroom is currently insufficient (e.g., 0 USDC available before
  this close confirms).

### Steps

1. 🟧 **ON-CHAIN — Bob's `closeCooperative(...)` confirms.**
   Contract pays 4 USDC to hub's hot wallet. Emits
   `ChannelClosedCooperative(idB, ...)`.

2. 🟦 **OFF-CHAIN — Hub's chain-watcher observes the event** and increments the
   hub's tracked hot-wallet USDC balance by 4 (or rereads on-chain).

3. 🟦 **OFF-CHAIN — Hub's auto-recycle hook runs:**
   - Hot-wallet USDC available now: 4 (was 0).
   - Pending top-up queue: [Carol (5 USDC requested)].
   - Carol's request (5) > available (4). Hub partially provisions: top up by
     4 instead of 5, OR waits for the next close that frees ≥ 5. Policy is
     implementation-defined; for this scenario, hub picks "top up by 4 now."

4. 🟦 **OFF-CHAIN — Hub WS-pushes `proposeTopUp` to Carol** with `amount: 4` and
   a co-signed candidate state for `idC` with `balanceB = 4`.

5. 🟦 **OFF-CHAIN — Carol accepts.** Returns `acceptTopUp` with sigA.

6. 🟧 **ON-CHAIN — Hub calls `topUp(idC, 4_000_000, prevState=sentinel, newState=signedState)`.**
   - prevState is the sentinel `(version=0, balanceA=10, balanceB=0, ZERO_SIGs)`
     because Carol's channel has not seen any co-signed state yet.
   - newState: `{version=1, balanceA=10, balanceB=4, htlcsRoot=0}`, both sigs.
   - Pulls 4 USDC from hub's hot wallet (the same 4 that just arrived from
     Bob's close).
   - `channels[idC].amountB += 4`.
   - Emits `ToppedUp(idC, hub, 4, 1)`.

**Post-state:**

- On-chain:
  - Bob's channel: `Closed`. Bob has received 11 USDC, hub received 4 USDC,
    then 4 USDC went back into the contract via topUp.
  - Carol's channel: `{ Carol, Hub, 10, 4 }`, `postedVersion=1`. Carol can now
    receive routed payments up to 4 USDC.
- Hub hot-wallet USDC: started at 0 (insufficient pre-close), gained 4 from
  Bob's close, spent 4 on Carol's topUp → 0 again. Capital cycled fully.
- Off-chain: Carol holds co-signed `stateC1 = { 10, 4, v=1 }` ready for routing.

**Key insight:** the hub never had to add fresh USDC to its hot wallet between
Bob's close and Carol's topUp. The same 4 USDC moved
contract → hub wallet → contract → Carol's channel pot, all within ~one block.
This is the "inbound auto-recycle" optimization specified in §8.8 of the
protocol spec.

**Failure modes (and how they are handled):**

- Hub crashes between close and recycle: on restart, chain-watcher replays the
  events, the auto-recycle hook re-fires.
- Carol disconnects before `acceptTopUp`: handled by Scenario 10
  (declined / timed-out top-up).
- Two recovered closes simultaneously: handled by Scenario 12 mutex
  (serializes hub's hot-wallet commitments).

---

## Quick mental model

| Concept | What it physically is |
|---|---|
| **Channel** | An on-chain record `(userA, userB, amountA, amountB, status)` plus an off-chain co-signed `state` that the contract trusts at close time. |
| **Channel state (off-chain)** | Monotonically-versioned JSON. Version 1 is the initial state, signed only by the opener (on-chain `ChannelOpened` amounts are the source of truth). Versions 2+ assert balance shifts or top-up amount changes; both sigs required. |
| **Outbound (for a party in a channel)** | Their `balance*` value in that channel. Burns when they send; refills when they receive. |
| **Inbound (for a party in a channel)** | The counterparty's outbound in the same channel. |
| **`topUp` (new)** | Either party adds to their own deposit during the channel's `open` phase. Requires a co-signed state version+1 with their balance increased by exactly the deposit amount. Updates `amountA` or `amountB` and the posted-state snapshot atomically. |
| **Hub's `topUp` policy** | The hub auto-evaluates each new `userX → hub` channel and proposes a top-up if its admission policy allows (per-counterparty cap, per-channel cap, hot-wallet headroom, mutex serialization). |
| **Inbound auto-recycle (RECOMMENDED, §8.8 of spec)** | When a channel that the hub topped up closes, the hub uses the recovered USDC to fulfill a queued or under-provisioned channel's top-up immediately. Pure hub-operational behavior — no contract change — but documented in the spec to set fee and capacity expectations. |

## Sources / prior art

- [Raiden Network `setTotalDeposit`](https://raiden-network-specification.readthedocs.io/en/latest/smart_contracts.html) — the canonical post-open additive-deposit primitive that this design borrows from.
- [Connext Vector router model](https://github.com/connext/vector/blob/main/README.md) — confirms per-channel staking is the right v1 architecture (vs. cross-channel pools).
- [Nitro Protocol ledger + virtual channels](https://docs.statechannels.org/protocol-tutorial/0060-funding-a-channel/) — the v2 direction once pico needs to scale.
- [LSPS2 (Bitcoin Lightning JIT channels)](https://github.com/BitcoinAndLightningLayerSpecs/lsp/blob/main/LSPS2/README.md) — alternative considered; doesn't port cleanly to Ethereum's account model.
- [Sprites paper (Miller, Bentov et al.)](https://arxiv.org/abs/1702.05812) — multi-hop optimization, not load-bearing for pico's 1-hop architecture.
