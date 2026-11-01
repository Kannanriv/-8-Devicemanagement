-- #8 Device Management — initial schema (Postgres / PGlite / Timescale compatible).
-- Hot query fields are real columns (indexed); the full domain object lives in `doc jsonb`
-- so the API contract can evolve without a migration for every optional field.

CREATE TABLE IF NOT EXISTS tenants (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('oem','solution','customer')),
  parent_id   text REFERENCES tenants(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS models (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  codec_id    text,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS models_tenant_idx ON models (tenant_id);

CREATE TABLE IF NOT EXISTS batches (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  model_id    text NOT NULL REFERENCES models(id),
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batches_tenant_idx ON batches (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  id                text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants(id),
  oem_tenant_id     text NOT NULL REFERENCES tenants(id),
  model_id          text NOT NULL REFERENCES models(id),
  serial            text NOT NULL UNIQUE,
  udi               text NOT NULL UNIQUE,
  oem               text NOT NULL DEFAULT '',
  organization      text,
  branch            text,
  asset_id          text,
  lifecycle         text NOT NULL,
  connectivity      text NOT NULL DEFAULT 'never_seen',
  health_level      text NOT NULL DEFAULT 'normal',
  ota_status        text,
  installed_at      timestamptz,
  firmware_version  text,
  tags              text[] NOT NULL DEFAULT '{}',
  health_score      integer NOT NULL DEFAULT 0,
  last_seen_at      timestamptz,
  search            text NOT NULL DEFAULT '',
  doc               jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_tenant_lifecycle_idx ON devices (tenant_id, lifecycle);
CREATE INDEX IF NOT EXISTS devices_oem_idx ON devices (oem_tenant_id);
CREATE INDEX IF NOT EXISTS devices_tenant_id_idx ON devices (tenant_id, id);
CREATE INDEX IF NOT EXISTS devices_model_idx ON devices (model_id);
CREATE INDEX IF NOT EXISTS devices_firmware_idx ON devices (tenant_id, firmware_version);
CREATE INDEX IF NOT EXISTS devices_tags_idx ON devices USING gin (tags);
CREATE INDEX IF NOT EXISTS devices_org_branch_idx ON devices (tenant_id, organization, branch);
CREATE INDEX IF NOT EXISTS devices_connectivity_idx ON devices (tenant_id, connectivity);
CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS devices_asset_idx ON devices (asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS codec_versions (
  codec_id      text NOT NULL,
  version       text NOT NULL,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  status        text NOT NULL,
  spec          jsonb NOT NULL,
  summary       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  PRIMARY KEY (codec_id, version)
);
CREATE INDEX IF NOT EXISTS codec_versions_status_idx ON codec_versions (codec_id, status);

-- Codec access grants (OEM owns the codec; solution/customer tenants gain access when devices transfer).
CREATE TABLE IF NOT EXISTS codec_access (
  codec_id    text NOT NULL,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (codec_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS spec_imports (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  doc         jsonb NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spec_imports_tenant_idx ON spec_imports (tenant_id, created_at DESC);

-- Hypertable candidate in Timescale: SELECT create_hypertable('messages', 'received_at');
CREATE TABLE IF NOT EXISTS messages (
  id             text NOT NULL,
  tenant_id      text NOT NULL,
  device_id      text NOT NULL,
  received_at    timestamptz NOT NULL,
  status         text NOT NULL,
  transport      text NOT NULL,
  port           integer,
  topic          text,
  payload_hex    text NOT NULL,
  message        text,
  codec_id       text,
  codec_version  text,
  data           jsonb,
  warnings       jsonb NOT NULL DEFAULT '[]',
  errors         jsonb,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS messages_device_time_idx ON messages (device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS messages_tenant_time_idx ON messages (tenant_id, received_at DESC);

CREATE TABLE IF NOT EXISTS unknown_payloads (
  id             text PRIMARY KEY,
  tenant_id      text NOT NULL,
  device_id      text,
  serial         text,
  received_at    timestamptz NOT NULL,
  transport      text NOT NULL,
  port           integer,
  topic          text,
  payload_hex    text NOT NULL,
  codec_id       text,
  codec_version  text,
  reason         text NOT NULL,
  errors         jsonb NOT NULL DEFAULT '[]',
  resolved_at    timestamptz,
  resolved_message_id text
);
CREATE INDEX IF NOT EXISTS unknown_tenant_time_idx ON unknown_payloads (tenant_id, received_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS unknown_device_idx ON unknown_payloads (device_id);

CREATE TABLE IF NOT EXISTS timeline (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  device_id   text NOT NULL,
  at          timestamptz NOT NULL,
  kind        text NOT NULL,
  title       text NOT NULL,
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS timeline_device_time_idx ON timeline (device_id, at DESC);

CREATE TABLE IF NOT EXISTS device_configs (
  device_id    text PRIMARY KEY REFERENCES devices(id),
  tenant_id    text NOT NULL,
  desired      jsonb NOT NULL DEFAULT '{}',
  reported     jsonb NOT NULL DEFAULT '{}',
  template_id  text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_configs_tenant_idx ON device_configs (tenant_id);

CREATE TABLE IF NOT EXISTS config_templates (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  model_id    text NOT NULL,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS config_templates_tenant_idx ON config_templates (tenant_id, model_id);

CREATE TABLE IF NOT EXISTS commands (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  device_id   text NOT NULL,
  status      text NOT NULL,
  expires_at  timestamptz,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commands_device_idx ON commands (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commands_open_idx ON commands (status, expires_at) WHERE status IN ('queued','sent');

CREATE TABLE IF NOT EXISTS firmware (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  model_id    text NOT NULL,
  version     text NOT NULL,
  file_path   text,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, version)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  status      text NOT NULL,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_tenant_idx ON campaigns (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns (status);

CREATE TABLE IF NOT EXISTS campaign_devices (
  campaign_id  text NOT NULL REFERENCES campaigns(id),
  device_id    text NOT NULL,
  wave         integer NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  from_version text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, device_id)
);
CREATE INDEX IF NOT EXISTS campaign_devices_wave_idx ON campaign_devices (campaign_id, wave, status);

CREATE TABLE IF NOT EXISTS alerts (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  device_id   text,
  status      text NOT NULL,
  severity    text NOT NULL,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_tenant_status_idx ON alerts (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS automations (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automations_tenant_idx ON automations (tenant_id);

CREATE TABLE IF NOT EXISTS integrations (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integrations_tenant_idx ON integrations (tenant_id);

-- Local in-process sink for hash8-* integrations / webhooks without a URL (dev).
CREATE TABLE IF NOT EXISTS integration_deliveries (
  id              text PRIMARY KEY,
  integration_id  text NOT NULL,
  tenant_id       text NOT NULL,
  event           text NOT NULL,
  status          text NOT NULL,
  attempts        integer NOT NULL DEFAULT 1,
  signature       text,
  target          text,
  body            jsonb NOT NULL,
  response        jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_deliveries_idx ON integration_deliveries (integration_id, at DESC);

CREATE TABLE IF NOT EXISTS audit (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL,
  target      text NOT NULL,
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS audit_tenant_time_idx ON audit (tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_target_idx ON audit (target, at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  agent       text NOT NULL,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_tenant_idx ON agent_runs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kv (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
