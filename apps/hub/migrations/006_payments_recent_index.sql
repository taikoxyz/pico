-- Speeds up GET /v1/payments/recent. Without this, PaymentRepo.recent does
-- a full-table sort because the existing retention indexes (003) partition by
-- channel and so cannot cover a cross-channel ORDER BY. The expression must
-- match PaymentRepo.recent exactly so the planner can use it.

CREATE INDEX idx_payments_recent
  ON payments(CAST(created_at AS BIGINT) DESC, id DESC);
