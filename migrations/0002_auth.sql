-- Operational authentication storage; domain entities remain in schema/rota.yaml.
CREATE TABLE auth_session (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_session_expiry ON auth_session(expires_at);
CREATE TABLE auth_flow (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_flow_expiry ON auth_flow(expires_at);
