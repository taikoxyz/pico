# Security disclosure runbook

Operator playbook for the disclosure flow described in
[`SECURITY.md`](../../SECURITY.md). Two parts:

1. **Setup (one-time)** — provisioning the inbox, PGP key, and paging.
2. **On receipt of a report** — triage and incident playbook.
3. **Dry-run drill** — quarterly fire drill to validate the whole chain.

## Setup (one-time)

### Email forward via Cloudflare Email Routing

1. The disclosure address lives on `taiko.xyz`, which is operated by Taiko
   Labs. Coordinate with the Taiko domain owner to add the email route below.
2. Cloudflare → Email → Email Routing → Routes → Custom address
   `security@taiko.xyz` → forward to maintainer mailbox(es). Multiple
   destinations are supported and recommended once a second maintainer
   exists.
3. The wizard adds the required MX + TXT records. Wait for DNS propagation
   (a few minutes typically).
4. **Verify deliverability** with a real test message before announcing the
   address. Send to `security@taiko.xyz` and confirm it lands in the
   maintainer inbox(es).
5. **Forwarding only.** Never reply directly from the forward address —
   replies should come from a maintainer's signed key.

### PGP key generation

Run on a clean, encrypted laptop. Hardware-backed storage (YubiKey OpenPGP
applet, Nitrokey) is strongly preferred for the secret key.

```bash
gpg --quick-generate-key 'Pico Security <security@taiko.xyz>' \
  ed25519 sign 5y
gpg --quick-add-key <FPR> cv25519 encr 5y
gpg --armor --export <FPR> > pgp-key.asc
gpg --armor --export-secret-keys <FPR> > /secure/offline/storage/pico-security.priv.asc
gpg --send-keys --keyserver hkps://keys.openpgp.org <FPR>
```

After upload, verify the key is searchable:
<https://keys.openpgp.org/search?q=security@taiko.xyz>

Then in a single PR:

- Commit `pgp-key.asc` to repo root.
- Delete `pgp-key.asc.placeholder`.
- Replace `<PICO_PGP_FINGERPRINT_TODO>` in `SECURITY.md` with the real
  fingerprint (40-char hex, spaces every 4 chars).
- Update the **Open TODOs** section at the bottom of this runbook.

The CI check at `.github/workflows/security-md-lint.yml` enforces atomicity:
the PR fails if any of the three changes are missing.

### Paging rotation

Until a second maintainer joins, the rotation is a degenerate single-person
schedule with @dantaik on call 24/7 via:

- GitHub Advisory creation → notification email + GitHub mobile push.
- Cloudflare Email Routing → forwarded mailbox push notifications.

When a second maintainer joins, fill in:

- A real PagerDuty schedule URL (e.g.
  `https://pico.pagerduty.com/schedules/<id>`) or a Linear on-call rotation.
- Severity → page level mapping:
  - Critical: SMS + PagerDuty page within 5 min.
  - High: email page within 1 hour.
  - Medium / low: queued in tracking advisory, reviewed during business hours.

Update `CODEOWNERS` to add the second maintainer at the same time.

## On receipt of a report (incident playbook)

Time-stamped checklist. Adjust SLA labels per `SECURITY.md` if the report's
severity differs from the worst-case assumption.

### T+0 min

- Triage inbox: Cloudflare-forwarded email or GitHub Advisory notification.
- Confirm receipt internally in maintainer Slack/Signal.

### T+0 to T+24 hours

- Send acknowledgement to reporter:

  ```
  Subject: [pico-sec-<id>] Acknowledged — initial triage in progress

  Hi <name>, thanks for the report. We received it at <UTC ts> and have
  opened a private tracking advisory. Triage decision (severity + owner +
  patch ETA) within 72h.

  — Pico security
  ```

- Open a **private** GitHub Security Advisory at
  <https://github.com/dantaik/pico/security/advisories/new>. Paste report
  details. Add the reporter as a collaborator on the advisory (with consent).

### T+0 to T+72 hours

- Assess severity using **CVSS v3.1**:
  <https://www.first.org/cvss/calculator/3.1>. Record the vector string and
  base score in the advisory.
- Assign owner. Single-maintainer mode → owner is @dantaik. Set patch
  deadline by severity per `SECURITY.md` SLA table.
- Notify reporter of triage decision.

### Fix and disclose

- Draft fix in the **private fork** that GitHub creates from the advisory.
- Run all tests in the private fork. Do not push to public branches.
- Coordinate disclosure window with reporter. Default 90 days; if patched
  earlier, ship and disclose earlier with reporter consent.
- If CVE applies: request via the advisory's "Request CVE" button or via
  MITRE if GitHub declines. Embargo until coordinated release.
- Public release: tag a version, publish the advisory, append release notes,
  add reporter to `SECURITY_HALL_OF_FAME.md`.

## Dry-run drill (quarterly, mandatory pre-launch)

Validates the whole chain end-to-end without a real vulnerability.

### Test message

Operator sends from a personal address, encrypted with the published PGP key:

```
Subject: [DRILL] Pico security inbox liveness check — <UTC ts>

This is a scheduled drill, not a real report. Please acknowledge within 24h.
Drill ID: <random-uuid>
```

### Verification checklist

- [ ] Drill arrives at the maintainer mailbox within 5 min (proves Cloudflare
      Email Routing is live).
- [ ] Maintainer can decrypt with the local copy of the secret key (proves
      the PGP fingerprint in `SECURITY.md` matches the one published to
      keys.openpgp.org).
- [ ] Maintainer creates a private GitHub Security Advisory titled
      `[DRILL] <uuid>` and adds the drill sender as collaborator.
- [ ] Page fires (PagerDuty / Discord / GitHub email) within the SLA defined
      in the rotation section.
- [ ] Maintainer sends acknowledgement reply within 24h.
- [ ] After confirmation, close the advisory with `[DRILL — no real vuln]`.

Record drill date + outcome in your team operations log. Close the
corresponding sub-issue under
[issue #21](https://github.com/dantaik/pico/issues/21) after the first
successful drill.

## Open TODOs

Things that cannot be fixed in-repo. Replace as the operator stands them up:

- [ ] PagerDuty / Linear schedule URL.
- [ ] Real PGP fingerprint (replaces `<PICO_PGP_FINGERPRINT_TODO>` in
      `SECURITY.md`).
- [ ] Cloudflare Email Routing destination addresses confirmed live.
- [ ] Backup maintainer GitHub handles in `CODEOWNERS`.
