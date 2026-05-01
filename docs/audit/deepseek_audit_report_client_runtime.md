# Client Runtime Audit Report

## Executive summary

The client runtime is not ready for mainnet fund custody. The highest-risk issue is that the SDK accepts hub/counterparty-supplied signed states and persists or builds new signatures from them without verifying signatures, channel identity, state transitions, balances, or expected HTLC contents. A malicious hub is the real counterparty in the hub-and-spoke model, so this is a fund-safety blocker, not just a defensive programming gap.

The code does implement persist-before-send for the outgoing HTLC happy path, and tests assert that the locked state is on disk before `transport.send()` fires. However, recovery after restart is incomplete: subscribed `pendingHtlcs` are ignored, in-flight payment promises are memory-only, and settlement/failure messages without current in-memory state are dropped.

Other mainnet blockers are missing invoice replay/expiry checks on inbound settlement, weak runtime wire validation, local state durability and permission gaps, CLI secret exposure paths, fee semantics that diverge from the protocol document, public test-only APIs, DVM/Nostr stubs exposed as package functionality, and supported chain constants that still include zero-address placeholders.

## Component boundary

Audited scope:

- `packages/sdk`: `ChannelClient`, storage backends, wire codec, signer/key helpers, chain adapter, relevant tests and README.
- `apps/cli`: channel/pay/listen/invoice/keys commands, runtime signer/passphrase/storage/output helpers, relevant tests and README.
- `packages/dvm-adapter`: payment tag codec, method selection, listener stub, README.
- `examples`: SDK mock flow.
- Directly relevant protocol/docs/tests: `packages/protocol/src/constants.ts`, `docs/protocol-spec.md`, `docs/threat-model.md`, selected state-machine verification helpers.

No source code was modified by this audit.

## Findings table

| ID | Severity | Area | Finding | Readiness impact |
|---|---|---|---|---|
| F-01 | Critical | SDK state verification | Hub/counterparty states are persisted or signed over without signature, channel, transition, or balance verification. | Mainnet fund-safety blocker. |
| F-02 | High | Crash safety | Persist-before-send exists, but restart/reconnect reconciliation of pending HTLCs is incomplete. | Funds can be stuck or local state can diverge after process crash/network loss. |
| F-03 | High | Invoices | Inbound invoices ignore expiry, recipient, and consumed/replay state; payer-side replay cache is absent. | Stale or repeated invoices can be settled; preimages remain reusable. |
| F-04 | High | Wire/runtime validation | Hub messages, invoice envelopes, storage files, and DVM payment tags are parsed with casts and minimal shape checks. | Malicious or corrupted input can crash processes or poison state before safety checks. |
| F-05 | High | State durability/permissions | File storage lacks fsync and explicit restrictive modes; IndexedDB storage does not request persistence; invoice preimages are plaintext. | Lost latest signed state or leaked preimages can become fund-safety incidents. |
| F-06 | High | CLI secrets | CLI accepts secrets in argv/env/plaintext files and prints private keys/preimages in normal workflows. | Hot keys and preimages can leak through shell history, process listings, CI logs, and operator logs. |
| F-07 | Medium | Fee semantics | SDK defaults to zero fees despite protocol constants/docs specifying 10 bps + 1 unit; no fee policy negotiation or validation. | Hub/client accounting can diverge; fee-invariant mitigation is not implemented as documented. |
| F-08 | Medium | DVM/Nostr | Public DVM/Nostr APIs are stubs or under-validate routing choice. | Integrators can build on non-functional or unsafe discovery paths. |
| F-09 | Medium | Chain constants | `SUPPORTED_CHAIN_IDS` includes chains with zero contract/token addresses; CLI/SDK paths consume these maps without zero-address guards. | Non-mainnet use can attempt zero-address calls; deployment readiness is ambiguous. |
| F-10 | Medium | Public API hygiene | `signer.test-only` and `_test` exports are published; production `LocalSigner` extends the test-only signer. | Test-only hot-key utilities are part of the public SDK surface. |

## Detailed findings

### F-01 - Critical - SDK signs and persists unverified hub/counterparty states

**Evidence file references**

- `packages/sdk/src/client.ts:285`: `handleHtlcOffer()` loads only the local channel by `msg.channelId`.
- `packages/sdk/src/client.ts:349`: settlement is computed from `msg.signedStateBeforeHtlc.state`.
- `packages/sdk/src/client.ts:357`: the client combines its new signature with `msg.signedStateBeforeHtlc.sigA`/`sigB`.
- `packages/sdk/src/client.ts:362`: the resulting state is persisted before any verification of the counterparty signature or state transition.
- `packages/sdk/src/client.ts:481`: `payDirect()` only checks the acked version.
- `packages/sdk/src/client.ts:486`: `payDirect()` persists `reply.signedState` directly.
- `packages/sdk/src/client.ts:619`: outgoing HTLC settlement only checks the preimage hash.
- `packages/sdk/src/client.ts:629`: outgoing settlement reuses `settled.signedStateAfterSettle` signatures without verification.
- `packages/sdk/src/client.ts:709`: cooperative close accepts `closeResponse`.
- `packages/sdk/src/client.ts:710`: cooperative close persists `reply.signedCloseState` before on-chain submission.
- `packages/state-machine/src/signing.ts:181`: `verifyChannelStateSignature()` exists but is not used in `ChannelClient`.

**Observed behavior**

The client does not verify that hub-supplied signed states:

- belong to the expected `channelId`;
- have the expected version relative to local storage;
- preserve balances and valid HTLC transitions;
- are signed by `channel.userA` and `channel.userB`;
- contain the expected HTLC id, payment hash, amount, direction, and expiry;
- match the state the client believes it is acknowledging.

**Impact**

In the intended hub-and-spoke topology, the hub is the counterparty. A malicious or compromised hub can propose arbitrary state, obtain the client's signature, and leave the client with a persisted state that may be stale, invalid, adverse, or unclosable. This undermines channel safety and dispute readiness.

**Recommended fix**

Add a single SDK state acceptance gate before any persisted state update or new signature:

- validate wire shape first;
- load local channel and latest local state;
- assert channel id, contract, chain id, parties, token, and status;
- verify both signatures on every `SignedState` using expected party addresses;
- validate monotonic version and balance conservation with the state-machine rules;
- validate HTLC-specific invariants for offer/settle/fail/payDirect/close;
- persist only after all checks pass.

Reject or quarantine invalid messages and emit structured errors without signing.

**Tests/checks needed**

- Malicious `htlcOffer` with wrong `channelId`, stale version, wrong balances, wrong direction, expired HTLC, and invalid counterparty signature.
- Malicious `payDirectAck` with correct version but wrong balances/channel/signature.
- Malicious `paymentSettle` with valid preimage but wrong channel or invalid counterparty signature.
- Malicious `closeResponse` with non-finalized state, wrong channel, stale version, or invalid signatures.
- Property tests that accepted state transitions preserve total channel value.

### F-02 - High - Persist-before-send is partial; restart/reconnect recovery is missing

**Evidence file references**

- `packages/sdk/src/client.ts:556`: outgoing `pay()` saves locked state before `transport.send()`.
- `packages/sdk/src/client.ts:558`: in-flight payments are held in an in-memory `Map`.
- `packages/sdk/src/client.ts:573`: the pay request is sent after persistence.
- `packages/sdk/src/client.ts:232`: `ensureSubscribed()` receives a subscribe reply.
- `packages/sdk/src/client.ts:233`: it only handles `error`.
- `packages/sdk/src/hub-protocol.ts:27`: `SubscribeAckMessage` includes `channels` and `pendingHtlcs`.
- `packages/sdk/src/client.ts:258`: inbound `paymentSettle` is ignored if there is no matching in-memory pending payment.
- `packages/sdk/src/client.crash.test.ts:86`: crash test only asserts state persisted when send fails.
- `packages/sdk/src/client.mockhub.test.ts:227`: happy-path test only checks state is on disk before send.

**Observed behavior**

The outgoing HTLC path has persist-before-send ordering, but the SDK does not reconstruct in-flight payments from storage after restart. `SubscribeAckMessage.pendingHtlcs` is not processed. Settlement/failure messages for persisted HTLCs are ignored when the original `pay()` promise is gone.

**Impact**

After a process crash or network reconnect, funds can remain locked in HTLCs until timeout/manual intervention, and the local state may not converge with the hub/counterparty's latest signed state. This is a liveness and recovery blocker for unattended clients and CLI listeners.

**Recommended fix**

Implement a recovery loop:

- on startup/reconnect, load latest state for each open channel;
- reconcile subscribe `channels` and `pendingHtlcs`;
- rebuild pending HTLC tracking from persisted states;
- accept valid late `paymentSettle`/`paymentFailed` for known persisted HTLCs even without an active `pay()` promise;
- expose an explicit `recover()`/`sync()` method and call it from CLI `pay`/`listen`/`channel close`;
- add idempotent settlement/failure handling.

**Tests/checks needed**

- Crash after save before send.
- Crash after send before settle.
- Crash after inbound state save before `htlcSettle` send.
- Reconnect with `SubscribeAckMessage.pendingHtlcs`.
- Late settle/fail message after process restart with no in-memory `inflight` entry.

### F-03 - High - Invoice expiry, replay, and recipient checks are incomplete

**Evidence file references**

- `packages/sdk/src/invoice.ts:48`: `verifyInvoice()` supports expiry, signature, and optional recipient checks.
- `packages/sdk/src/client.ts:492`: payer-side `pay()` verifies invoice signature/expiry.
- `packages/sdk/src/client.ts:297`: receiver loads invoice by `paymentHash`.
- `packages/sdk/src/client.ts:301`: receiver only checks underpayment.
- `packages/sdk/src/client.ts:306`: receiver uses the stored preimage without checking expiry, consumed state, or recipient.
- `packages/sdk/src/client.ts:363`: invoice is marked consumed after local state save.
- `packages/sdk/src/storage.ts:56`: memory storage preserves `consumedAt`.
- `packages/sdk/src/storage-file.ts:124`: file storage stores invoice records including preimage.
- `packages/sdk/src/storage-file.test.ts:136`: tests preserve `consumedAt`, but no test asserts consumed invoices are rejected.

**Observed behavior**

Inbound invoice settlement does not call `verifyInvoice()` against the local signer, does not reject expired invoices, and does not reject `record.consumedAt`. The payer side also does not record paid invoice nonces/payment hashes, so a user or automation can pay the same invoice more than once.

**Impact**

Invoice preimages are reusable for the same `paymentHash`. Replaying stale or already-paid invoices can cause repeated settlement attempts and accidental duplicate payments. Receiver-side expiry and recipient checks are necessary to avoid honoring stale/tampered local invoice records.

**Recommended fix**

- On inbound invoice HTLC, require `record.consumedAt === undefined`.
- Call `verifyInvoice(record.invoice, { chainId, expectedRecipient: myAddress })`.
- Reject expired invoices and HTLCs too close to expiry.
- Persist a payer-side paid-invoice/replay cache keyed by `chainId + recipient + nonce + paymentHash`.
- Make invoice consumption atomic with settlement intent, and define recovery behavior for crash between consume and send.

**Tests/checks needed**

- Inbound expired invoice is failed.
- Inbound consumed invoice is failed.
- Inbound invoice with recipient not equal to local signer is failed.
- Duplicate `pay({ invoice })` is rejected or requires an explicit unsafe override.
- Crash between marking consumed and sending `htlcSettle` recovers deterministically.

### F-04 - High - Runtime wire validation is mostly compile-time casting

**Evidence file references**

- `packages/sdk/src/hub-protocol.ts:172`: `decodeHubMessage()` parses JSON.
- `packages/sdk/src/hub-protocol.ts:174`: it checks only object, `kind`, and `id`.
- `packages/sdk/src/hub-protocol.ts:182`: it casts to `HubMessage`.
- `packages/sdk/src/transport.ts:153`: transport casts decoded input to `HubToClientMessage`.
- `apps/cli/src/runtime/invoice-envelope.ts:36`: invoice envelope casts parsed JSON to `InvoiceWire`.
- `apps/cli/src/runtime/invoice-envelope.ts:39`: envelope fields are cast to protocol types after `BigInt()`.
- `packages/sdk/src/storage-shared.ts:146`: deserialized signatures are cast without shape/length checks.
- `packages/sdk/src/storage-shared.ts:167`: deserialized invoices are cast without address/hash/signature validation.
- `packages/dvm-adapter/src/payment-tag.ts:44`: DVM tag chain id is `Number(...) as ChainId`.
- `packages/dvm-adapter/src/payment-tag.ts:45`: DVM tag amount is `BigInt(...)` without positive-range validation.

**Observed behavior**

Runtime inputs from the hub, CLI invoice envelope, local storage, and DVM tags are trusted after minimal parsing. Invalid hex, negative or malformed amounts, wrong variants, extra fields, missing nested fields, and wrong signature lengths are not rejected at the boundary.

**Impact**

Malformed or adversarial data can crash the CLI/listener, poison local state, or reach signing/persistence code before semantic safety checks. This compounds F-01 because untrusted messages are accepted as typed protocol objects.

**Recommended fix**

Use a shared runtime schema layer for all external boundaries:

- discriminated schemas for every hub message kind;
- branded validators for `Address`, `Hex`, `ChannelId`, `PaymentHash`, `Preimage`, and signatures;
- bigint parsing with non-negative/range constraints;
- strict invoice envelope and DVM tag schemas;
- strict storage deserialization with corruption quarantine.

**Tests/checks needed**

- Fuzz malformed hub JSON and ensure no state change/signature happens.
- Malformed invoice envelope tests for missing fields, invalid base64, invalid hex, negative amount, bad signature length.
- Corrupt storage file/IndexedDB records are rejected or quarantined.
- DVM tag parser rejects unsupported chains, zero/negative amount, malformed addresses, and extra/ambiguous fields.

### F-05 - High - Local file and IndexedDB durability/permission controls are insufficient

**Evidence file references**

- `packages/sdk/src/storage-file.ts:49`: atomic write helper writes a temp file.
- `packages/sdk/src/storage-file.ts:51`: `writeFile()` uses default mode/umask and no file fsync.
- `packages/sdk/src/storage-file.ts:53`: `rename()` is used without directory fsync.
- `packages/sdk/src/storage-file.ts:76`: storage directories are created without explicit `0700`.
- `packages/sdk/src/storage-file.ts:124`: invoice records are persisted with preimages.
- `packages/sdk/src/storage-indexeddb.ts:70`: IndexedDB opens a normal database.
- `packages/sdk/src/storage-indexeddb.ts:116`: signed states are stored in IndexedDB.
- `packages/sdk/src/storage-indexeddb.ts:137`: invoice preimages are stored in IndexedDB.
- `packages/sdk/src/storage-file.test.ts:129`: file storage test only checks no temp file remains after success.

**Observed behavior**

File storage is atomic by rename, but not crash-durable across power loss because neither file data nor parent directory entries are fsynced. Storage file modes are not restricted. IndexedDB storage does not request persistent storage (`navigator.storage.persist()`), does not document eviction risk, and stores preimages in plaintext.

**Impact**

Losing the latest signed state is a channel fund-safety issue because a counterparty may hold a newer signature than the client can dispute with. Plaintext invoice preimages allow any local compromise or browser-origin compromise to settle matching HTLCs.

**Recommended fix**

- For Node file storage: create root/subdirectories with `0700`, files with `0600`, write via open/write/fsync/close/rename/fsync(parent dir) where supported.
- Add corruption handling and backups/journaling for last-known-good signed states.
- For IndexedDB: expose a persistence request/helper, warn if persistence is denied, and document browser eviction limitations.
- Encrypt invoice preimages at rest or delegate to a key-management interface.
- Add explicit state export/backup and recovery guidance.

**Tests/checks needed**

- File mode tests for dirs and channel/state/invoice files.
- Fault-injection tests for interrupted writes and corrupted JSON.
- Recovery tests from `.tmp` files and last-good backups.
- Browser storage persistence-denied behavior documented and surfaced.

### F-06 - High - CLI secret handling leaks private keys and preimages through common channels

**Evidence file references**

- `apps/cli/src/runtime/signer.ts:26`: `--private-key` is accepted.
- `apps/cli/src/runtime/signer.ts:31`: `TAINNEL_PRIVATE_KEY` is accepted.
- `apps/cli/src/runtime/signer.ts:69`: plaintext key files are read.
- `apps/cli/src/runtime/signer.ts:70`: plaintext private key files are accepted.
- `apps/cli/src/commands/keys.ts:40`: `keys import --from <hex>` puts a private key in argv.
- `apps/cli/src/commands/keys.ts:51`: `keys show --reveal-private` is supported.
- `apps/cli/src/commands/keys.ts:114`: plaintext private keys can be printed.
- `apps/cli/src/commands/keys.ts:129`: encrypted private keys can be decrypted and printed.
- `apps/cli/src/commands/invoice.ts:193`: `invoice create --json` emits preimage.
- `apps/cli/src/commands/invoice.ts:256`: `invoice show --reveal-preimage` prints preimage.
- `apps/cli/src/commands/pay.ts:144`: `pay --json` emits settlement preimage.
- `apps/cli/src/commands/pay.ts:148`: non-JSON pay prints settlement preimage.

**Observed behavior**

The CLI warns for `--private-key` and `TAINNEL_PRIVATE_KEY`, and generated encrypted key files are written `0600`. But production commands still accept secrets in argv/env/plaintext files and expose preimages/private keys in stdout.

**Impact**

Private keys in argv can appear in shell history and process listings. Env vars leak into CI logs, crash dumps, subprocesses, and host introspection. Preimages in stdout can be captured by logs and reused to settle matching HTLCs. These are high-risk defaults for an operator CLI.

**Recommended fix**

- Remove or hide `--private-key` from production help; require `--unsafe-private-key` plus an explicit environment opt-in for tests.
- Replace `keys import --from <hex>` with prompt/stdin/file-descriptor input.
- Reject plaintext key files by default; require `--unsafe-allow-plaintext-key`.
- Avoid printing private keys; if retained, require an interactive confirmation and refuse non-TTY output.
- Redact preimages by default; add `--reveal-preimage` for settlement output only when explicitly requested.
- Warn when `TAINNEL_PASSPHRASE` is used outside CI/test mode.

**Tests/checks needed**

- CLI help does not advertise unsafe key paths in production mode.
- Non-TTY `keys show --reveal-private` fails unless explicitly overridden.
- Plaintext key file loading fails by default.
- `pay` and `invoice create --json` redact preimages by default.

### F-07 - Medium - Fee semantics diverge from protocol policy

**Evidence file references**

- `docs/protocol-spec.md:197`: fee is specified as `DEFAULT_HUB_FEE_BPS` plus `DEFAULT_HUB_FEE_FLAT`.
- `docs/protocol-spec.md:202`: sender HTLC amount is `amount + fee`, hub HTLC amount is `amount`.
- `docs/threat-model.md:62`: threat model says fee discrepancy is caught client-side.
- `packages/protocol/src/constants.ts:57`: default fee bps is `10n`.
- `packages/protocol/src/constants.ts:58`: default flat fee is `1n`.
- `packages/sdk/src/client.ts:99`: SDK default `hubFeeBps` is `0n`.
- `packages/sdk/src/client.ts:100`: SDK default `hubFeeFlat` is `0n`.
- `packages/sdk/src/client.ts:505`: SDK computes fee locally.
- `packages/sdk/src/client.ts:570`: pay message sends only `amount: totalAmount`.
- `packages/sdk/src/client.ts:302`: receiver accepts any HTLC amount greater than or equal to invoice amount.

**Observed behavior**

The SDK default fee policy is zero, while protocol constants and docs specify 10 bps plus 1 unit. There is no hub-advertised fee policy, signed quote, or receiver-side separation between user amount and hub fee.

**Impact**

Clients, hubs, and receivers can disagree on settlement amounts. In the current direct/mock topology, a non-zero fee would be credited to the receiver rather than retained by the hub unless a real router rewrites the second leg. The threat-model claim that the SDK catches fee discrepancy is not implemented in a verifiable way.

**Recommended fix**

- Make fee policy explicit in hub metadata/quote and bind it into the payment request.
- Default SDK options to protocol constants or require caller-specified policy.
- Distinguish `recipientAmount`, `hubFee`, and `senderHtlcAmount` on the wire.
- Add client-side max-fee caps and signed fee-policy verification.

**Tests/checks needed**

- SDK default fee equals protocol constants or throws until configured.
- Payment refuses hub fee above payer's max.
- Receiver gets invoice amount, not `amount + fee`.
- Hub fee accounting is covered in end-to-end tests.

### F-08 - Medium - DVM/Nostr APIs are public but stubbed or unsafe for routing

**Evidence file references**

- `packages/sdk/src/transport.ts:301`: `NostrRelayTransport` is exported.
- `packages/sdk/src/transport.ts:310`: Nostr connect throws "not implemented".
- `packages/dvm-adapter/src/listener.ts:15`: `DvmListener.start()` throws.
- `packages/dvm-adapter/src/listener.ts:19`: `DvmListener.stop()` throws.
- `packages/dvm-adapter/README.md:3`: README advertises DVM tag encoding, payment selection, and relay listener.
- `packages/dvm-adapter/src/select.ts:17`: method selection only checks open status and token.
- `packages/dvm-adapter/src/payment-tag.ts:44`: tag decoder casts arbitrary numeric chain id to `ChainId`.

**Observed behavior**

The DVM adapter is published as functional glue, but listener behavior is not implemented. Channel selection ignores quote chain id, recipient, amount, channel balance, and hub hints.

**Impact**

Applications may route DVM payments over the wrong channel or rely on relay/listener code that only fails at runtime. This is not currently a core SDK fund-safety issue, but it is unsafe as a public integration surface.

**Recommended fix**

- Mark DVM/Nostr APIs experimental or remove from stable exports until implemented.
- Make `selectPaymentMethod()` validate chain id, token, recipient/counterparty/hub, available balance, and fee policy.
- Fail closed when no exact compatible channel exists.
- Update README to state current limitations.

**Tests/checks needed**

- DVM selection rejects wrong chain id, insufficient balance, wrong recipient/hub, zero amount, and zero token address.
- Listener tests with real or mocked Nostr relay behavior before public readiness.

### F-09 - Medium - Supported chain constants include zero-address placeholders

**Evidence file references**

- `packages/protocol/src/constants.ts:11`: `SUPPORTED_CHAIN_IDS` includes mainnet and Hoodi.
- `packages/protocol/src/constants.ts:24`: Hoodi `PaymentChannel` is `ZERO_ADDRESS`.
- `packages/protocol/src/constants.ts:25`: Hoodi `Adjudicator` is `ZERO_ADDRESS`.
- `packages/protocol/src/constants.ts:41`: Hoodi USDC address is `ZERO_ADDRESS`.
- `packages/protocol/src/constants.ts:47`: Anvil USDC address is `ZERO_ADDRESS`.
- `apps/cli/src/commands/channel.ts:44`: CLI recognizes Hoodi in `chainFor()`.
- `apps/cli/src/commands/channel.ts:92`: CLI consumes `CONTRACT_ADDRESSES[chainId].PaymentChannel`.
- `apps/cli/src/commands/channel.ts:94`: CLI consumes `USDC_TOKENS[chainId].address`.
- `apps/cli/src/commands/pay.ts:47`: pay command recognizes Hoodi in `chainFor()`.
- `apps/cli/src/commands/pay.ts:90`: pay command consumes `CONTRACT_ADDRESSES[chainId].PaymentChannel`.

**Observed behavior**

Hoodi is presented as supported at the protocol level while its contract and token addresses are placeholders. CLI code paths consume these maps without a zero-address guard. The CLI currently defaults to mainnet and does not expose a general `--chain-id` flag for channel/pay/listen, so the direct CLI blast radius is limited, but SDK users and dependency-injected CLI tests can hit these paths.

**Impact**

Zero-address contract/token usage can cause failed transactions, misleading invoices, or unsafe test/prod confusion. Mainnet address correctness also needs deployment verification outside this static audit.

**Recommended fix**

- Remove placeholder chains from `SUPPORTED_CHAIN_IDS` or represent deployment status explicitly.
- Throw on zero `PaymentChannel`, `Adjudicator`, or token address unless a named local-dev mode is active.
- Add runtime deployment verification for CLI startup/open/pay/listen.
- Verification needed: confirm current mainnet addresses match audited deployed bytecode and expected constructor/config.

**Tests/checks needed**

- CLI/SDK constructors reject zero contract/token addresses.
- `SUPPORTED_CHAIN_IDS` excludes undeployed networks or tests assert deployment status.
- Mainnet constants are checked against chain metadata/bytecode in a release gate.

### F-10 - Medium - Test-only APIs and hot-key signer are part of the public SDK surface

**Evidence file references**

- `packages/sdk/package.json:15`: package exports `./signer.test-only`.
- `packages/sdk/package.json:19`: package exports `./_test`.
- `packages/sdk/package.json:24`: package files include `src`.
- `packages/sdk/src/_test/index.ts:1`: `_test` exports mock chain adapter and mock hub.
- `packages/sdk/src/_test/index.ts:3`: `_test` exports `InMemorySigner`.
- `packages/sdk/src/local-signer.ts:5`: production `LocalSigner` imports `InMemorySigner` from `signer.test-only`.
- `packages/sdk/src/local-signer.ts:16`: `LocalSigner` extends `InMemorySigner`.

**Observed behavior**

The SDK deliberately exposes test-only helpers and makes production hot-key signing inherit from the test-only signer implementation.

**Impact**

This blurs custody boundaries and encourages production consumers to use in-memory hot keys. It also expands the public API surface that must be supported and audited.

**Recommended fix**

- Move test helpers to `@tainnel/test-utils` only.
- Remove `./signer.test-only` and `./_test` from published SDK exports before stable release.
- Implement `LocalSigner` as a production module, not a subclass of a test-only class.
- Document signer custody expectations and prefer external signer/KMS interfaces for mainnet.

**Tests/checks needed**

- Package export snapshot excludes test-only subpaths.
- SDK README no longer points production users to test signers.
- CLI tests import test helpers from `@tainnel/test-utils`.

## Readiness blockers

- Block mainnet fund custody until F-01 is fixed and adversarial hub/counterparty state tests pass.
- Block unattended CLI/listener operation until F-02 recovery and reconciliation are implemented.
- Block invoice/keysend production flows until F-03 replay/expiry/recipient checks are enforced.
- Block public hub connectivity until F-04 runtime schema validation rejects malformed wire/storage/input data before signing.
- Block recommendations to use `FileStorage`/`IndexedDBStorage` for real funds until F-05 durability, permissions, and preimage-at-rest protections are addressed.
- Block operator CLI production guidance until F-06 unsafe key/preimage output paths are redesigned or gated.
- Block protocol readiness claims around hub fees until F-07 wire/accounting semantics match `docs/protocol-spec.md`.
- Block public DVM/Nostr readiness claims until F-08 stubs are removed or clearly marked experimental.
- Block non-mainnet supported-chain claims until F-09 zero placeholders are removed or guarded.

## Validation notes

- Inspection was static/read-only except for creating this report file.
- No formatters or source-mutating commands were run.
- Build/test commands were not run to avoid creating artifacts outside the requested report file.
- Existing tests confirm some happy paths: persist-before-send ordering, invoice signature/expiry verification on the payer side, storage round trips, and CLI key-file mode. They do not cover adversarial hub messages, restart recovery, consumed-invoice replay, file fsync behavior, malformed wire input, or zero-address rejection.
- Mainnet deployment verification was not performed in this static audit. The mainnet addresses in `packages/protocol/src/constants.ts` must be checked against live deployed bytecode/config before release.
- File path changed: `deepseek_audit_report_client_runtime.md`.
