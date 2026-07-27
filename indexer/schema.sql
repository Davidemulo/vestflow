-- VestFlow Event Indexer — SQLite schema
-- Idempotent: safe to re-run on an existing database.

CREATE TABLE IF NOT EXISTS schedule_events (
  -- Stellar-assigned event ID: "<ledger>-<txIndex>-<eventIndex>"
  id TEXT PRIMARY KEY,

  event_type TEXT NOT NULL CHECK (event_type IN ('schedule_created', 'claimed', 'revoked', 'unknown')),

  ledger            INTEGER NOT NULL,
  ledger_closed_at  TEXT    NOT NULL, -- ISO 8601 (from Stellar RPC)

  schedule_id INTEGER,    -- parsed from topic[1]
  grantor     TEXT,       -- parsed from topic[2] for schedule_created / revoked
  beneficiary TEXT,       -- parsed from topic[2] for claimed; topic[3] for created
  amount      TEXT,       -- bigint as decimal string (claimed events only)
  token       TEXT,       -- parsed Stellar asset contract address when available
  created_amount TEXT,    -- bigint as decimal string (schedule_created events only)

  raw_topics TEXT NOT NULL, -- JSON array of native-decoded topic values
  raw_value  TEXT NOT NULL, -- JSON of native-decoded event value

  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_grantor      ON schedule_events (grantor);
CREATE INDEX IF NOT EXISTS idx_beneficiary  ON schedule_events (beneficiary);
CREATE INDEX IF NOT EXISTS idx_schedule_id  ON schedule_events (schedule_id);
CREATE INDEX IF NOT EXISTS idx_event_type   ON schedule_events (event_type);
CREATE INDEX IF NOT EXISTS idx_ledger       ON schedule_events (ledger);
CREATE INDEX IF NOT EXISTS idx_token        ON schedule_events (token);

-- Singleton checkpoint row — stores the highest fully-processed ledger.
CREATE TABLE IF NOT EXISTS checkpoint (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO checkpoint (id, last_ledger) VALUES (1, 0);

-- Analytics Cache — Updated periodically with aggregate stats
CREATE TABLE IF NOT EXISTS analytics_cache (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  total_value_locked      TEXT NOT NULL DEFAULT '0',    -- bigint as string
  total_claimed           TEXT NOT NULL DEFAULT '0',    -- bigint as string
  active_schedules        INTEGER NOT NULL DEFAULT 0,
  unique_beneficiaries    INTEGER NOT NULL DEFAULT 0,
  total_schedules_created INTEGER NOT NULL DEFAULT 0,
  total_revoked           INTEGER NOT NULL DEFAULT 0,
  last_updated            INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO analytics_cache (id) VALUES (1);

-- Daily snapshot for trend tracking
CREATE TABLE IF NOT EXISTS daily_stats (
  date                    TEXT NOT NULL PRIMARY KEY,  -- YYYY-MM-DD
  total_value_locked      TEXT NOT NULL,
  total_claimed           TEXT NOT NULL,
  active_schedules        INTEGER NOT NULL,
  unique_beneficiaries    INTEGER NOT NULL,
  total_schedules_created INTEGER NOT NULL,
  total_revoked           INTEGER NOT NULL,
  created_at              INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats (date);

-- TVL cache per asset, refreshed by the poller and readable by /stats/tvl.
CREATE TABLE IF NOT EXISTS tvl_stats (
  asset                  TEXT PRIMARY KEY,
  total_created          TEXT NOT NULL,
  total_claimed          TEXT NOT NULL,
  total_revoked_unvested TEXT NOT NULL,
  total_value_locked     TEXT NOT NULL,
  active_schedules       INTEGER NOT NULL,
  last_updated           INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Notification subscriptions
CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  schedule_id INTEGER NOT NULL,
  beneficiary_address TEXT NOT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('cliff_reached', 'claimable', 'revoked', 'all')),
  is_active INTEGER NOT NULL DEFAULT 1,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sub_email ON notification_subscriptions (email);
CREATE INDEX IF NOT EXISTS idx_sub_schedule ON notification_subscriptions (schedule_id);
CREATE INDEX IF NOT EXISTS idx_sub_beneficiary ON notification_subscriptions (beneficiary_address);
CREATE INDEX IF NOT EXISTS idx_sub_active ON notification_subscriptions (is_active);

-- Notification events/history
CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('cliff_reached', 'claimable', 'revoked')),
  schedule_id INTEGER NOT NULL,
  sent_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('queued', 'sent', 'failed', 'bounced')),
  error_message TEXT,
  FOREIGN KEY (subscription_id) REFERENCES notification_subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notif_event_sub ON notification_events (subscription_id);
CREATE INDEX IF NOT EXISTS idx_notif_event_type ON notification_events (event_type);
CREATE INDEX IF NOT EXISTS idx_notif_event_status ON notification_events (status);
CREATE INDEX IF NOT EXISTS idx_notif_event_schedule ON notification_events (schedule_id);

-- Processed notification milestones (to avoid duplicate notifications)
CREATE TABLE IF NOT EXISTS notification_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  milestone_type TEXT NOT NULL CHECK (milestone_type IN ('cliff_reached', 'fully_vested', 'revoked')),
  processed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(schedule_id, milestone_type)
);

CREATE INDEX IF NOT EXISTS idx_milestone_schedule ON notification_milestones (schedule_id);

-- Beneficiary index table for O(1) lookup of schedules by recipient address
-- Mirrors the BeneficiarySchedules(Address) storage in the smart contract
CREATE TABLE IF NOT EXISTS beneficiary_schedules (
  beneficiary TEXT NOT NULL,
  schedule_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (beneficiary, schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_beneficiary_schedules_beneficiary ON beneficiary_schedules (beneficiary);

-- Web Push subscriptions
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  schedule_id INTEGER NOT NULL,
  beneficiary_address TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_push_endpoint ON web_push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS idx_push_schedule ON web_push_subscriptions (schedule_id);
CREATE INDEX IF NOT EXISTS idx_push_beneficiary ON web_push_subscriptions (beneficiary_address);
CREATE INDEX IF NOT EXISTS idx_push_active ON web_push_subscriptions (is_active);

-- Auth nonces — short-lived challenges issued to wallets before signing,
-- consumed by /api/auth/verify to prevent replay.
CREATE TABLE IF NOT EXISTS nonces (
  nonce       TEXT PRIMARY KEY,
  public_key  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,     -- ISO 8601
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nonces_public_key ON nonces (public_key);
