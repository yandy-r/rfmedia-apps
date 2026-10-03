-- rfapps-cli SQLite Schema
-- Stores deployment history for tracking and rollback capabilities

-- Schema version tracking
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Track deployment operations for history and rollback
CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  service TEXT NOT NULL,
  action TEXT NOT NULL,           -- deploy, rebuild, delete, rollback, apply, prune
  image_tag TEXT,                 -- Image used (nullable, image used if applicable)
  image_id TEXT,                  -- Immutable daemon-local image ID (nullable)
  image_digest TEXT,              -- Canonical repository digest (nullable)
  config_snapshot TEXT,           -- JSON snapshot of service config (nullable)
  status TEXT NOT NULL,           -- success, failed, rolled_back
  plan_id TEXT,                   -- Reference to plan if from apply (nullable)
  error_message TEXT              -- Error details if failed (nullable)
);

CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployments(service);
CREATE INDEX IF NOT EXISTS idx_deployments_timestamp ON deployments(timestamp);
CREATE INDEX IF NOT EXISTS idx_deployments_action ON deployments(action);

-- Immutable per-service generation snapshots (Nix-style generational state).
-- One generation is created for every successful deploy-like action
-- (deploy, rebuild, apply, rollback). Generations are append-only and
-- never updated or deleted by the CLI.
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  generation INTEGER NOT NULL,     -- Per-service generation number (1, 2, 3, ...)
  deployment_id INTEGER,           -- Originating deployments.id (nullable)
  timestamp TEXT NOT NULL,         -- ISO 8601 timestamp of the snapshot
  image_tag TEXT,                  -- Image used (nullable)
  image_id TEXT,                   -- Immutable daemon-local image ID (nullable)
  image_digest TEXT,               -- Canonical repository digest (nullable)
  config_snapshot TEXT,            -- JSON snapshot of service config (nullable)
  created_by_action TEXT NOT NULL, -- deploy, rebuild, apply, rollback
  UNIQUE (service, generation),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);

CREATE INDEX IF NOT EXISTS idx_generations_service ON generations(service);
CREATE INDEX IF NOT EXISTS idx_generations_timestamp ON generations(timestamp);

-- The identity-dependent recovery lookup index is created by runMigrations()
-- after legacy generations tables have received the image_id column. Keeping
-- it out of schema-first DDL allows real v1/v2 databases to bootstrap safely.

-- Initialize schema version (new databases start at the current version;
-- existing databases keep their stored version and are upgraded by migrations)
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '3');
