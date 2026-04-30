CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  contract TEXT NOT NULL,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  dispute_window_ms TEXT NOT NULL
);

CREATE INDEX idx_channels_user_a ON channels(user_a);
CREATE INDEX idx_channels_user_b ON channels(user_b);
CREATE INDEX idx_channels_status ON channels(status);

CREATE TABLE signed_states (
  channel_id TEXT NOT NULL,
  version TEXT NOT NULL,
  state_json TEXT NOT NULL,
  sig_a TEXT NOT NULL,
  sig_b TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, version)
);

CREATE INDEX idx_signed_states_channel_recorded ON signed_states(channel_id, recorded_at DESC);

CREATE TABLE htlcs (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount TEXT NOT NULL,
  payment_hash TEXT NOT NULL,
  expiry_ms TEXT NOT NULL,
  state TEXT NOT NULL,
  incoming_channel_id TEXT,
  outgoing_channel_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_htlcs_state ON htlcs(state);
CREATE INDEX idx_htlcs_channel ON htlcs(channel_id);
CREATE INDEX idx_htlcs_payment_hash ON htlcs(payment_hash);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  payment_hash TEXT NOT NULL,
  incoming_channel_id TEXT,
  outgoing_channel_id TEXT,
  incoming_htlc_id TEXT,
  outgoing_htlc_id TEXT,
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL,
  fee TEXT NOT NULL,
  status TEXT NOT NULL,
  preimage TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  failed_at TEXT
);

CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_payment_hash ON payments(payment_hash);

CREATE TABLE seen_nonces (
  nonce TEXT PRIMARY KEY,
  signer TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_seen_nonces_expires ON seen_nonces(expires_at);

CREATE TABLE disputes (
  channel_id TEXT NOT NULL,
  observed_version TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  responded_at TEXT,
  response_tx_hash TEXT,
  resolution TEXT,
  PRIMARY KEY (channel_id, observed_version)
);

CREATE INDEX idx_disputes_resolution ON disputes(resolution);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
