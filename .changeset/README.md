# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets), one
markdown file per planned version bump for the publishable packages under
`packages/*`.

```bash
pnpm changeset            # author a new changeset
pnpm version-packages     # apply pending changesets, bumping versions
pnpm release              # build + publish (CI only)
```

Apps under `apps/*` are versioned at `0.0.0` and ignored by changesets — they ship as
deployable artifacts, not as published npm packages.
