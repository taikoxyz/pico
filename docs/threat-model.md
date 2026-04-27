# Threat model (v0)

> Status: bootstrap placeholder. Each section names an adversary or fault and reserves
> space for goals, capabilities, mitigations, and residual risk.

## Malicious user

A signer who attempts to publish stale state, double-spend, or grief a hub.

## Malicious hub

A hub operator who attempts to refuse service, stall HTLCs, censor specific
counterparties, or steal in-flight funds.

## Malicious DVM

A Data Vending Machine that produces fake quotes, mis-prices invoices, or claims
delivery without performing the work.

## Network partition

A counterparty cannot be reached during a critical window (e.g., the dispute window or
HTLC expiry).

## Chain reorg

A finalized-by-the-app state turns out to be on an orphaned fork. How tainnel reasons
about block confirmations and the implications for `closeUnilateral` and `finalize`.

## Watchtower offline

A watchtower fails to post a penalty before the dispute window closes.
