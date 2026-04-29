# P11 — Learning materials

**Status:** 🟡 in progress — initial set drafted in this re-scope session
**Blocks:** —
**Effort:** ~3–4 days, parallelizable with all other phases
**Depends on:** nothing — source content comes from the code, protocol docs, and
technical plans, but readiness tracking stays in `ROADMAP.md` and `docs/plans/`.

## Why this exists as its own phase

The user wants to deeply understand every component before the mainnet real-money
test. Without
purpose-built, self-contained tutorials, the only way in is reading source plus the
plans in `docs/plans/`. That's enough for an engineer; not enough for a
"hand-this-to-an-AI-agent-or-a-non-Solidity-friend" onboarding experience. This phase
delivers a `learning/` folder of well-designed HTML pages that can be opened from
disk with no build step, no JavaScript, and no internet connection.

## Format constraints (locked in)

- **Single self-contained HTML file per page.** Embedded `<style>`. No external CSS,
  no CDN scripts, no MCP / cloud integrations. Pages must work with JS off.
- **Inline SVG only** — no `<img>` tags or external image references. Diagrams are
  pre-rendered Mermaid → SVG (or hand-authored SVG) and pasted inline.
- **Offline-readable.** Open `learning/index.html` from a finder window and every link
  works.
- **Cross-links use relative paths** (`./05-hub.html`, `./00-big-picture.html`).
- **800–1500 words per component page.** No filler. The goal is to learn, not to
  perform exhaustiveness.
- **Consistent style across pages.** All 10 pages share the same `<style>` block.

## File structure

```
learning/
├── index.html                  Entry / cover page, table of contents, glossary
├── 00-big-picture.html         Story walkthrough (Alice/Bob/hub/watchtower)
├── 01-contracts.html           PaymentChannel.sol + Adjudicator.sol + HTLC.sol
├── 02-protocol.html            Wire format, EIP-712 schemas, constants
├── 03-state-machine.html       validateUpdate / applyUpdate / signing / HTLC root
├── 04-sdk.html                 ChannelClient, Signer interface, transport, storage
├── 05-hub.html                 Routing, persistence, dispute handling, REST + WS
├── 06-watchtower.html          Chain watching, penalty submission, encrypted backups
├── 07-agent-runtime.html       CLI commands, `tainnel listen`, hot key file
└── 08-e2e.html                 End-to-end test scenarios + how to run them
```

(`learning/_diagrams/` may exist with the Mermaid sources used to generate inline SVG;
this is optional but useful for diff hygiene when a diagram needs editing.)

## Per-page template

Every component page (`01–08`) follows the same skeleton:

1. **What is it** — one-paragraph intro for a non-expert.
2. **Why it exists** — the specific problem it solves in the state-channel system.
3. **Key concepts** — defined terms; link to the glossary in `index.html`.
4. **How it works** — sequence diagram (inline SVG) + 1–2 paragraphs.
5. **Public surface** — table of key types / functions with file paths and line ranges
   (sourced from the audits captured during the v1 re-scope session).
6. **Verification model** — what tests, invariants, or review concepts prove the
   design works, without turning the page into a status checklist.
7. **Design constraints** — the technical boundaries, tradeoffs, and invariants that
   shape the component.
8. **Read next** — link to the next logical component page.

## Implementation tasks

### Skeleton
- [ ] `[agent]` Author `learning/index.html` first as the canonical style template.
      Embedded CSS (color palette, serif body, monospace code, card layouts), table
      of contents linking to all 10 pages, glossary table, "where to start"
      block.
- [ ] `[agent]` Author `learning/00-big-picture.html` next: a narrative walkthrough
      (Alice the AI agent pays Bob the AI agent via the hub; hub goes silent; Alice
      unilaterally closes; hub posts a stale state; watchtower posts the fresher
      state; cheater gets slashed). Inline SVG sequence diagram for the happy path
      and a state diagram for the dispute branch.

### Component pages (one per package / app)
- [ ] `[agent]` `01-contracts.html` — `PaymentChannel.sol`, `Adjudicator.sol`,
      `HTLC.sol`. Source content from the contract audit captured during this
      session.
- [ ] `[agent]` `02-protocol.html` — wire format, EIP-712 schemas, constants. Source
      from `packages/protocol/`.
- [ ] `[agent]` `03-state-machine.html` — `validateUpdate`, `applyUpdate`,
      `computeBalance`, `signing`, `htlcsRoot`. Source from `packages/state-machine/`
      and `docs/plans/03-state-machine.md`.
- [ ] `[agent]` `04-sdk.html` — `ChannelClient`, `Signer` interface, transport,
      storage. Source from `packages/sdk/` and `docs/plans/04-sdk.md`.
- [ ] `[agent]` `05-hub.html` — channel pool, router, dispute handler, REST/WS API.
      Source from `apps/hub/` and `docs/plans/05-hub.md`.
- [ ] `[agent]` `06-watchtower.html` — detector, responder, scheduler. Source from
      `apps/watchtower/` and `docs/plans/06-watchtower.md`.
- [ ] `[agent]` `07-agent-runtime.html` — CLI commands, `tainnel listen` daemon,
      hot key file format. Source from `apps/cli/` and
      `docs/plans/07-agent-runtime.md`.
- [ ] `[agent]` `08-e2e.html` — scenarios, how to run them, what they prove. Source
      from `e2e/` and `docs/plans/08-e2e-and-audit.md`.

### Diagrams
- [ ] `[agent]` Generate Mermaid → SVG for each component page (sequence diagrams
      for happy paths; state diagrams where useful). Use
      `npx @mermaid-js/mermaid-cli -i src.mmd -o out.svg` and inline the SVG into
      the HTML page. Do **not** embed the Mermaid runtime.

### Sync rule
- [ ] `[review]` PR template gets a checkbox: "If this PR changes
      `packages/<pkg>/` or `apps/<app>/`, the corresponding `learning/<n>-*.html`
      page has been updated (or a follow-up issue has been filed)." Don't enforce
      with CI in v1 — checkbox + reviewer attention is enough.

## `[review]` gates

- You read `learning/index.html` end-to-end. Confirm the glossary covers every term
  used by the component pages.
- You read `learning/00-big-picture.html`. The story should be self-consistent with
  the component pages it links to (no contradictions).
- You spot-check at least one component page you did not write. Confirm: it can be
  read alone, the diagram is clear, and it contains design/technical details only,
  not readiness tracking copied from `ROADMAP.md`.

## Done when

- All 10 HTML files exist, render standalone with JS off, embedded CSS only.
- Cross-page links resolve when opened from disk (no `file://` 404s).
- The `00-big-picture.html` story matches the actual code paths described on the
  component pages.
- No page contains a readiness/gap checklist; current status and remaining work live
  only in `ROADMAP.md` and `docs/plans/`.
- Branch merged with `docs(learning): per-component HTML tutorials + big picture`
