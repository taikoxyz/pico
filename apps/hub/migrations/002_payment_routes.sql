-- WS-9: durable in-flight route table so router state can be rebuilt after
-- restart. Without this, a hub crash with in-flight HTLCs loses all
-- in-memory route mappings (incoming HTLC -> outgoing HTLC, sender,
-- recipient, signed states), and settle/fail messages for those HTLCs are
-- silently dropped.

CREATE TABLE payment_routes (
  incoming_channel_id   TEXT NOT NULL,
  incoming_htlc_id      TEXT NOT NULL,
  outgoing_channel_id   TEXT NOT NULL,
  outgoing_htlc_id      TEXT NOT NULL,
  sender                TEXT NOT NULL,
  recipient             TEXT NOT NULL,
  payment_hash          TEXT NOT NULL,
  -- Persisted SignedState rows so the router can rehydrate without
  -- re-querying state-repo (which would race with concurrent updates).
  incoming_signed_state TEXT NOT NULL,
  outgoing_hub_signed   TEXT NOT NULL,
  outgoing_htlc_json    TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('inflight', 'settled', 'failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (outgoing_channel_id, outgoing_htlc_id)
);

CREATE UNIQUE INDEX idx_payment_routes_incoming
  ON payment_routes(incoming_channel_id, incoming_htlc_id);
CREATE INDEX idx_payment_routes_state ON payment_routes(state);
CREATE INDEX idx_payment_routes_recipient ON payment_routes(recipient);
