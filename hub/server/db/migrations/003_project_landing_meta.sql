-- Cached project landing page metadata (synced from workspace bionic.yaml & disk stats)
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS bionic_meta_json JSONB,
  ADD COLUMN IF NOT EXISTS workspace_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ;
