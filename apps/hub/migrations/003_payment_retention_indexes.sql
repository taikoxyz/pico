-- Speeds up payment retention pruning, which ranks recent terminal payments
-- per incoming/outgoing channel by created_at.

CREATE INDEX idx_payments_incoming_recent
  ON payments(incoming_channel_id, CAST(created_at AS BIGINT) DESC, id DESC)
  WHERE incoming_channel_id IS NOT NULL;

CREATE INDEX idx_payments_outgoing_recent
  ON payments(outgoing_channel_id, CAST(created_at AS BIGINT) DESC, id DESC)
  WHERE outgoing_channel_id IS NOT NULL;
