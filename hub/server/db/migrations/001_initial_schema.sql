-- Bionic Hub PostgreSQL 16 Initial Schema (v3)
-- All secrets are referenced via Secret Manager URIs; zero plaintext secrets in Postgres.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4.1 Identity, Auth, Subdomain Handoff & RBAC
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  display_name TEXT NOT NULL,
  oidc_sub TEXT NOT NULL,
  oidc_issuer TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'researcher', 'viewer')) DEFAULT 'researcher',
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')) DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  UNIQUE (oidc_issuer, oidc_sub)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_active_email
  ON users (LOWER(email)) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  external_claim_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_memberships (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS editor_auth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
  target_origin TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('editor', 'live_report', 'publication')),
  resource_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scoped_origin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  parent_session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('editor', 'live_report', 'publication')),
  resource_id TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scoped_origin_sessions_parent
  ON scoped_origin_sessions (parent_session_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ci_oidc_trust_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  subject_pattern TEXT NOT NULL,
  allowed_scopes TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4.2 Versioned Admin Config Registries (GitOps)
CREATE TABLE IF NOT EXISTS config_revisions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('template', 'model', 'skill', 'mcp')),
  slug TEXT NOT NULL,
  version INT NOT NULL,
  content_yaml TEXT NOT NULL,
  parsed_json JSONB NOT NULL,
  content_sha256 TEXT NOT NULL,
  git_commit_sha TEXT,
  git_repo TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'deprecated', 'disabled')) DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, slug, version)
);

CREATE TABLE IF NOT EXISTS templates (
  slug TEXT PRIMARY KEY,
  active_revision_id TEXT NOT NULL REFERENCES config_revisions(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  allowed_group_ids TEXT[] NOT NULL DEFAULT '{}',
  default_idle_timeout_min INT NOT NULL DEFAULT 20,
  max_idle_timeout_min INT NOT NULL DEFAULT 180,
  allowlisted_sa_email TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS models (
  slug TEXT PRIMARY KEY,
  active_revision_id TEXT NOT NULL REFERENCES config_revisions(id) ON DELETE RESTRICT,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('openai', 'anthropic', 'gemini', 'ollama', 'aws_bedrock', 'vertex')),
  protocol TEXT NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'google')),
  display_name TEXT NOT NULL,
  allowed_group_ids TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skills (
  slug TEXT PRIMARY KEY,
  active_revision_id TEXT NOT NULL REFERENCES config_revisions(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  bundle_storage_uri TEXT,
  bundle_sha256 TEXT,
  allowed_group_ids TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  slug TEXT PRIMARY KEY,
  active_revision_id TEXT NOT NULL REFERENCES config_revisions(id) ON DELETE RESTRICT,
  transport TEXT NOT NULL CHECK (transport IN ('streamable_http', 'sse', 'stdio')),
  routing TEXT NOT NULL CHECK (routing IN ('hub_gateway', 'vm_local')),
  allowed_group_ids TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4.3 Projects, Compute State, Leases & VM Attestation
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state_version INT NOT NULL DEFAULT 1,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_slug TEXT NOT NULL REFERENCES templates(slug) ON DELETE RESTRICT,
  template_revision_id TEXT NOT NULL REFERENCES config_revisions(id) ON DELETE RESTRICT,
  parent_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  parent_publication_id TEXT,
  forked_from_commit_sha TEXT,
  git_repo_ref TEXT,
  git_default_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL CHECK (status IN (
    'creating', 'provisioning', 'starting', 'running',
    'freezing', 'frozen', 'stopping', 'stopped',
    'resuming', 'archiving', 'archived',
    'deleting', 'deleted', 'error'
  )) DEFAULT 'creating',
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'frozen', 'stopped', 'archived', 'deleted')) DEFAULT 'running',
  status_message TEXT,
  transition_started_at TIMESTAMPTZ,
  pending_gcp_operation_id TEXT,
  busy_operation TEXT,
  busy_until TIMESTAMPTZ,
  compute_provider TEXT NOT NULL DEFAULT 'gcp',
  compute_zone TEXT,
  compute_instance_name TEXT,
  compute_instance_id TEXT,
  compute_internal_ip TEXT,
  compute_disk_name TEXT,
  compute_disk_size_gb INT,
  compute_snapshot_name TEXT,
  vm_cert_serial TEXT,
  vm_cert_expires_at TIMESTAMPTZ,
  vm_attested_at TIMESTAMPTZ,
  idle_timeout_minutes INT NOT NULL DEFAULT 20,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  frozen_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  data_bucket_prefix TEXT,
  pending_manifest_sync BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_active_slug
  ON projects (slug) WHERE status <> 'deleted';

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_active_instance
  ON projects (compute_instance_name) WHERE status NOT IN ('deleted', 'archived');

CREATE INDEX IF NOT EXISTS idx_projects_idle_scan
  ON projects (status, last_activity_at);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (project_id, user_id)
);

-- 4.4 Authoritative Data Catalog, Grants, Publications & Reproducible Runs
CREATE TABLE IF NOT EXISTS data_objects (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('shared', 'project')),
  owner_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  storage_uri TEXT NOT NULL UNIQUE,
  gcs_generation TEXT,
  sha256 TEXT NOT NULL DEFAULT '',
  crc32c TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  content_type TEXT,
  description TEXT NOT NULL DEFAULT '',
  acquisition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'deleted')) DEFAULT 'uploading',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_data_grants (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  data_object_id TEXT NOT NULL REFERENCES data_objects(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'read_write')),
  granted_via TEXT NOT NULL CHECK (granted_via IN ('upload', 'vm_sync', 'fork', 'shared_link')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, data_object_id)
);

CREATE TABLE IF NOT EXISTS pending_manifest_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  data_object_id TEXT NOT NULL REFERENCES data_objects(id) ON DELETE CASCADE,
  target_rel_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed')) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  version INT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  git_commit_sha TEXT NOT NULL,
  git_tag TEXT NOT NULL,
  template_slug TEXT NOT NULL REFERENCES templates(slug) ON DELETE RESTRICT,
  template_revision_id TEXT NOT NULL REFERENCES config_revisions(id) ON DELETE RESTRICT,
  storage_bucket_kind TEXT NOT NULL CHECK (storage_bucket_kind IN ('public', 'private')),
  static_site_url TEXT NOT NULL,
  artifact_storage_uri TEXT NOT NULL,
  manifest_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  bionic_yaml_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  test_results_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'org', 'public')) DEFAULT 'private',
  status TEXT NOT NULL CHECK (status IN ('publishing', 'ready', 'downgrading', 'deleted')) DEFAULT 'publishing',
  public_purge_pending BOOLEAN NOT NULL DEFAULT FALSE,
  published_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS publication_data_objects (
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  data_object_id TEXT NOT NULL REFERENCES data_objects(id) ON DELETE RESTRICT,
  gcs_generation TEXT,
  rel_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (publication_id, data_object_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE RESTRICT,
  source_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  git_commit_sha TEXT NOT NULL,
  template_slug TEXT NOT NULL REFERENCES templates(slug) ON DELETE RESTRICT,
  template_revision_id TEXT NOT NULL REFERENCES config_revisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'building_env', 'hydrating', 'running',
    'publishing', 'succeeded', 'failed', 'cancelled', 'timed_out'
  )) DEFAULT 'queued',
  compute_instance_name TEXT,
  pending_gcp_operation_id TEXT,
  output_publication_id TEXT REFERENCES publications(id) ON DELETE SET NULL,
  logs_storage_uri TEXT,
  test_results_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_duration_sec INT NOT NULL DEFAULT 3600,
  triggered_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4.5 Atomic Budgets, Usage, Jobs & Audit
CREATE TABLE IF NOT EXISTS daily_llm_spend (
  scope_key TEXT NOT NULL,
  utc_day DATE NOT NULL,
  spent_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  reserved_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_key, utc_day)
);

CREATE TABLE IF NOT EXISTS llm_spend_reservations (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  utc_day DATE NOT NULL,
  amount_usd NUMERIC(12, 6) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS llm_usage_events (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  model_slug TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  cached_tokens INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  latency_ms INT NOT NULL DEFAULT 0,
  status_code INT NOT NULL DEFAULT 200,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_project_time
  ON llm_usage_events (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_usage_user_time
  ON llm_usage_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  job_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead')) DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  locked_by TEXT,
  idempotency_key TEXT UNIQUE,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_dequeue
  ON jobs (queue, status, run_after);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id TEXT,
  actor_token_id TEXT,
  actor_ci_sub TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs (created_at DESC);

-- Seed default groups
INSERT INTO groups (id, slug, name) VALUES
  ('grp-00000000000000000000000001', 'admins', 'Administrators'),
  ('grp-00000000000000000000000002', 'researchers', 'Researchers')
ON CONFLICT (slug) DO NOTHING;
