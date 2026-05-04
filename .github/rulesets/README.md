# Repository Rulesets

This directory holds GitHub repository rulesets as committed JSON. The rulesets are
the source of truth for branch protection — to change protection rules, edit the
JSON here and re-apply via `gh api`.

## Files

- [`main.json`](./main.json) — protection for the default branch (`main`).

## What `main.json` enforces

- Direct pushes to `main` are blocked. All changes must go through a pull request.
- 1 approving review is required, and reviews must come from a code owner
  (see `.github/CODEOWNERS`).
- Stale approvals are dismissed when new commits land on the PR.
- All review threads must be resolved before merge.
- The `ci` status check (the aggregator job in `.github/workflows/ci.yml`) must
  pass, and the PR branch must be up-to-date with `main` (strict status checks).
- `main` cannot be deleted or force-pushed.

## Apply for the first time

Requires admin access on `dantaik/pico`.

```bash
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/dantaik/pico/rulesets \
  --input .github/rulesets/main.json
```

## Inspect existing rulesets

```bash
gh api /repos/dantaik/pico/rulesets
gh api /repos/dantaik/pico/rulesets/<ID>
```

## Update an existing ruleset

Find the ruleset's `id` from the list above, then `PUT` the new JSON:

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/dantaik/pico/rulesets/<ID> \
  --input .github/rulesets/main.json
```

## Delete a ruleset

```bash
gh api \
  --method DELETE \
  /repos/dantaik/pico/rulesets/<ID>
```

## Notes

- The required status check name `ci` matches the aggregator job in
  `.github/workflows/ci.yml`. Adding or renaming sub-jobs (`lint`, `typecheck`,
  `build`, `test-ts`, `test-solidity`) does **not** require updating this
  ruleset, because the aggregator only succeeds when all of them do.
- `bypass_actors` is empty, so no one (including the repo owner) can merge
  without satisfying the rules. To allow specific roles to bypass, add entries
  per the [GitHub rulesets docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).
