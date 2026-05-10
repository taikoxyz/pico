-- §8 inbound liquidity (`topUp`) — durable offer queue.
--
-- Each row tracks one proposeTopUp lifecycle:
--   queued    → awaiting headroom (auto-recycle target)
--   proposed  → envelope sent to user; awaiting accept/reject/timeout
--   accepted  → user signed; about to submit on-chain
--   submitted → on-chain topUp tx broadcast; awaiting ToppedUp event
--   confirmed → ToppedUp observed; channel amounts updated
--   rejected  → user replied rejectTopUp
--   expired   → no accept arrived before validUntil
--
-- Bigints (amount, versions, valid_until_sec) are stored as TEXT decimal
-- strings to avoid Number precision loss, matching state_repo / channel_repo.

CREATE TABLE topup_offers (
  offer_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  amount TEXT NOT NULL,
  prev_version TEXT NOT NULL,
  new_version TEXT NOT NULL,
  new_state_json TEXT NOT NULL,
  hub_sig_prev TEXT NOT NULL,
  hub_sig_new TEXT NOT NULL,
  valid_until_sec TEXT NOT NULL,
  status TEXT NOT NULL,
  submitted_tx_hash TEXT,
  user_signed_new_state_json TEXT,
  reject_reason TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_topup_offers_channel ON topup_offers(channel_id);
CREATE INDEX idx_topup_offers_counterparty ON topup_offers(counterparty);
CREATE INDEX idx_topup_offers_status ON topup_offers(status);
CREATE INDEX idx_topup_offers_priority ON topup_offers(priority DESC, queued_at ASC);

-- Tracks the channel's on-chain `amountA` / `amountB` so the hub can compute
-- per-channel HTLC value caps (§4.3) and detect post-topUp deposit changes.
-- Stored as TEXT decimal strings (bigints).
ALTER TABLE channels ADD COLUMN amount_a TEXT NOT NULL DEFAULT '0';
ALTER TABLE channels ADD COLUMN amount_b TEXT NOT NULL DEFAULT '0';
