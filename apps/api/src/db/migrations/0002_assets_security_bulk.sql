-- v1.1: assets + association history, device credentials (X.509), bulk jobs.

CREATE TABLE IF NOT EXISTS assets (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  type          text NOT NULL,
  organization  text,
  branch        text,
  search        text NOT NULL DEFAULT '',
  doc           jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_tenant_idx ON assets (tenant_id, organization, branch);
CREATE INDEX IF NOT EXISTS assets_type_idx ON assets (tenant_id, type);

CREATE TABLE IF NOT EXISTS asset_associations (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  asset_id   text NOT NULL REFERENCES assets(id),
  device_id  text NOT NULL,
  role       text NOT NULL,
  from_at    timestamptz NOT NULL,
  to_at      timestamptz,
  reason     text,
  actor      text NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_assoc_asset_idx ON asset_associations (asset_id, from_at DESC);
CREATE INDEX IF NOT EXISTS asset_assoc_device_idx ON asset_associations (device_id, from_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS asset_assoc_open_device_idx ON asset_associations (device_id) WHERE to_at IS NULL;

CREATE TABLE IF NOT EXISTS credentials (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  device_id   text NOT NULL,
  revoked_at  timestamptz,
  expires_at  timestamptz,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credentials_device_idx ON credentials (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credentials_expiry_idx ON credentials (tenant_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS bulk_jobs (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bulk_jobs_tenant_idx ON bulk_jobs (tenant_id, created_at DESC);
