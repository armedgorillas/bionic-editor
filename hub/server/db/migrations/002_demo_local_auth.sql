-- Migration 002: Demo-only manual email/password user invites + authenticated publication site scope

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE TABLE IF NOT EXISTS password_setup_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user
  ON password_setup_tokens (user_id);

-- Allow 'public_reports_site' scope for authenticated demo publication bucket proxy
ALTER TABLE editor_auth_codes DROP CONSTRAINT IF EXISTS editor_auth_codes_scope_check;
ALTER TABLE editor_auth_codes
  ADD CONSTRAINT editor_auth_codes_scope_check
  CHECK (scope IN ('editor', 'live_report', 'publication', 'public_reports_site'));

ALTER TABLE scoped_origin_sessions DROP CONSTRAINT IF EXISTS scoped_origin_sessions_scope_check;
ALTER TABLE scoped_origin_sessions
  ADD CONSTRAINT scoped_origin_sessions_scope_check
  CHECK (scope IN ('editor', 'live_report', 'publication', 'public_reports_site'));
