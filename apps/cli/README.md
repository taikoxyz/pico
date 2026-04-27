# @tainnel/cli

The `tainnel` developer/operator CLI: open and close channels, send payments, query hub
status, and spin up a Taiko anvil fork for local development.

After `pnpm build`, the binary is wired into the workspace root as `pnpm tainnel <cmd>`.

## Commands

```bash
pnpm tainnel hello                                 # smoke check; prints all package versions
pnpm tainnel channel open --hub <url> --amount 5
pnpm tainnel channel list
pnpm tainnel channel close <id> [--cooperative]
pnpm tainnel pay --to <address> --amount <usdc> --via <hub>
pnpm tainnel hub status <url>
pnpm tainnel dev anvil-fork
```
