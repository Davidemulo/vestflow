import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { parseNetwork, type NetworkName } from "./config";
import type { EventQueryParams, IndexedEvent, TvlStats } from "./types";

const DB_PATH = process.env.INDEXER_DB_PATH;

const SCHEMA_PATH = path.join(__dirname, "..", "schema.sql");

const dbs = new Map<NetworkName, Database.Database>();

function dbPathFor(network: NetworkName): string {
  const specific = process.env[`INDEXER_DB_PATH_${network.toUpperCase()}`];
  if (specific) return specific;
  // Preserve the legacy single-network path only for the poller's configured
  // network. Using it for both query values would mix Mainnet and Testnet rows.
  if (DB_PATH && network === parseNetwork(process.env.INDEXER_NETWORK)) {
    return DB_PATH;
  }
  return path.join(process.cwd(), `vestflow-events-${network}.db`);
}

function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/** Recreate schedule_events when the CHECK constraint predates proposal events. */
function migrateEventTypeCheck(db: Database.Database): void {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedule_events'`
    )
    .get() as { sql: string } | undefined;
  if (!row?.sql || row.sql.includes("proposal_created")) {
    return;
  }

  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE schedule_events_new (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'schedule_created',
          'claimed',
          'revoked',
          'proposal_created',
          'proposal_acknowledged',
          'proposal_activated',
          'proposal_expired',
          'unknown'
        )),
        ledger INTEGER NOT NULL,
        ledger_closed_at TEXT NOT NULL,
        schedule_id INTEGER,
        proposal_id INTEGER,
        grantor TEXT,
        beneficiary TEXT,
        amount TEXT,
        token TEXT,
        created_amount TEXT,
        raw_topics TEXT NOT NULL,
        raw_value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.exec(`
      INSERT INTO schedule_events_new (
        id, event_type, ledger, ledger_closed_at, schedule_id, proposal_id,
        grantor, beneficiary, amount, token, created_amount, raw_topics, raw_value, created_at
      )
      SELECT
        id, event_type, ledger, ledger_closed_at, schedule_id, proposal_id,
        grantor, beneficiary, amount, token, created_amount, raw_topics, raw_value, created_at
      FROM schedule_events;
    `);
    db.exec("DROP TABLE schedule_events");
    db.exec("ALTER TABLE schedule_events_new RENAME TO schedule_events");
    db.exec("CREATE INDEX IF NOT EXISTS idx_grantor ON schedule_events (grantor)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_beneficiary ON schedule_events (beneficiary)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_schedule_id ON schedule_events (schedule_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_proposal_id ON schedule_events (proposal_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_event_type ON schedule_events (event_type)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ledger ON schedule_events (ledger)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_token ON schedule_events (token)");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Ensure the event deduplication index exists for idempotency */
function ensureEventDedupIndex(db: Database.Database): void {
  try {
    // Check if the deduplication index already exists
    const existingIndex = db
      .prepare(
        `SELECT name FROM sqlite_master 
         WHERE type = 'index' AND name = 'idx_event_dedup'`
      )
      .get() as { name: string } | undefined;
    
    if (existingIndex) {
      return; // Index already exists
    }
    
    console.log('[db] Creating event deduplication index for enhanced idempotency...');
    
    // Create the deduplication index
    db.exec(`
      CREATE UNIQUE INDEX idx_event_dedup ON schedule_events (
        ledger, 
        event_type, 
        COALESCE(schedule_id, -1), 
        COALESCE(proposal_id, -1), 
        COALESCE(grantor, ''), 
        COALESCE(beneficiary, ''), 
        COALESCE(amount, ''), 
        COALESCE(token, '')
      )
    `);
    
    console.log('[db] Event deduplication index created successfully');
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      console.warn('[db] Duplicate events detected during index creation - removing duplicates...');
      
      // If there are duplicates, we need to clean them up first
      // Keep the first occurrence of each duplicate group
      db.exec(`
        DELETE FROM schedule_events 
        WHERE rowid NOT IN (
          SELECT MIN(rowid) 
          FROM schedule_events 
          GROUP BY ledger, event_type, 
                   COALESCE(schedule_id, -1), 
                   COALESCE(proposal_id, -1),
                   COALESCE(grantor, ''), 
                   COALESCE(beneficiary, ''), 
                   COALESCE(amount, ''), 
                   COALESCE(token, '')
        )
      `);
      
      // Try creating the index again
      db.exec(`
        CREATE UNIQUE INDEX idx_event_dedup ON schedule_events (
          ledger, 
          event_type, 
          COALESCE(schedule_id, -1), 
          COALESCE(proposal_id, -1), 
          COALESCE(grantor, ''), 
          COALESCE(beneficiary, ''), 
          COALESCE(amount, ''), 
          COALESCE(token, '')
        )
      `);
      
      console.log('[db] Duplicates removed and deduplication index created successfully');
    } else {
      console.error('[db] Failed to create event deduplication index:', error);
      throw error;
    }
  }
}

export function getDb(network = parseNetwork(undefined)): Database.Database {
  let db = dbs.get(network);
  if (!db) {
    db = new Database(dbPathFor(network));
    // WAL mode: safe concurrent reads from the query server while the
    // poller writes, without blocking either side.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    db.exec(schema);
    ensureColumn(db, "schedule_events", "token", "token TEXT");
    ensureColumn(db, "schedule_events", "created_amount", "created_amount TEXT");
    ensureColumn(db, "schedule_events", "proposal_id", "proposal_id INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_token ON schedule_events (token)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_proposal_id ON schedule_events (proposal_id)");
    migrateEventTypeCheck(db);
    ensureEventDedupIndex(db);
    dbs.set(network, db);
  }
  return db;
}

// ── Checkpoint ────────────────────────────────────────────────────────

export function getCheckpoint(network?: NetworkName): number {
  const row = getDb(network)
    .prepare("SELECT last_ledger FROM checkpoint WHERE id = 1")
    .get() as { last_ledger: number } | undefined;
  return row?.last_ledger ?? 0;
}

export function setCheckpoint(ledger: number, network?: NetworkName): void {
  getDb(network)
    .prepare("UPDATE checkpoint SET last_ledger = ? WHERE id = 1")
    .run(ledger);
}

// ── Events ────────────────────────────────────────────────────────────

export interface InsertEventRow {
  id: string;
  event_type: string;
  ledger: number;
  ledger_closed_at: string;
  schedule_id: number | null;
  proposal_id?: number | null;
  grantor: string | null;
  beneficiary: string | null;
  amount: string | null;
  token: string | null;
  created_amount: string | null;
  raw_topics: string;
  raw_value: string;
}

/**
 * Inserts an event row with enhanced idempotency.
 * Returns true if a new row was written, false if it already existed.
 * 
 * Idempotency is enforced by:
 * 1. Primary key constraint on Stellar event ID
 * 2. Unique index on event signature (ledger + content) to catch duplicate events with different IDs
 * 
 * This ensures that the same event cannot be inserted twice, even if delivered
 * from different sources (RPC vs Horizon) or with different Stellar IDs.
 */
export function insertEvent(row: InsertEventRow, network?: NetworkName): boolean {
  const db = getDb(network);
  
  try {
    // First try with INSERT OR IGNORE for the primary key constraint
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO schedule_events
          (id, event_type, ledger, ledger_closed_at, schedule_id, proposal_id,
           grantor, beneficiary, amount, token, created_amount, raw_topics, raw_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.event_type,
        row.ledger,
        row.ledger_closed_at,
        row.schedule_id,
        row.proposal_id ?? null,
        row.grantor,
        row.beneficiary,
        row.amount,
        row.token,
        row.created_amount,
        row.raw_topics,
        row.raw_value
      );
    
    return result.changes > 0;
  } catch (error) {
    // Handle unique constraint violations (from the dedup index)
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      // This is expected for duplicate events - they should be silently ignored
      console.debug(`[db] Duplicate event detected and ignored: ${row.id} (ledger ${row.ledger})`);
      return false;
    }
    
    // Re-throw unexpected errors
    console.error(`[db] Failed to insert event ${row.id}:`, error);
    throw error;
  }
}

/**
 * Batch insert events with enhanced error handling and transaction support.
 * Returns the number of new events inserted (duplicates are silently skipped).
 * 
 * This is more efficient for replay operations that process many events at once.
 */
export function insertEventsBatch(events: InsertEventRow[], network?: NetworkName): number {
  if (events.length === 0) return 0;
  
  const db = getDb(network);
  let insertedCount = 0;
  
  // Use a transaction for better performance and atomicity
  const transaction = db.transaction((eventRows: InsertEventRow[]) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO schedule_events
        (id, event_type, ledger, ledger_closed_at, schedule_id, proposal_id,
         grantor, beneficiary, amount, token, created_amount, raw_topics, raw_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    
    for (const row of eventRows) {
      try {
        const result = stmt.run(
          row.id,
          row.event_type,
          row.ledger,
          row.ledger_closed_at,
          row.schedule_id,
          row.proposal_id ?? null,
          row.grantor,
          row.beneficiary,
          row.amount,
          row.token,
          row.created_amount,
          row.raw_topics,
          row.raw_value
        );
        
        if (result.changes > 0) {
          insertedCount++;
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          // Duplicate event - continue with next event
          console.debug(`[db] Duplicate event in batch ignored: ${row.id}`);
          continue;
        }
        // Re-throw unexpected errors to abort the transaction
        throw error;
      }
    }
  });
  
  try {
    transaction(events);
    
    if (insertedCount > 0) {
      console.log(`[db] Batch inserted ${insertedCount} new events (${events.length - insertedCount} duplicates skipped)`);
    }
    
    return insertedCount;
  } catch (error) {
    console.error(`[db] Batch insert failed for ${events.length} events:`, error);
    throw error;
  }
}

/**
 * Check if an event already exists by its Stellar ID
 */
export function eventExists(eventId: string, network?: NetworkName): boolean {
  const row = getDb(network)
    .prepare("SELECT 1 FROM schedule_events WHERE id = ?")
    .get(eventId) as { "1": number } | undefined;
  return !!row;
}

/**
 * Check for potential duplicate events by content signature
 * This helps identify events that might be duplicates but have different IDs
 */
export function findSimilarEvents(
  ledger: number,
  eventType: string,
  scheduleId: number | null,
  network?: NetworkName
): { id: string; ledger: number }[] {
  return getDb(network)
    .prepare(
      `SELECT id, ledger FROM schedule_events 
       WHERE ledger = ? AND event_type = ? AND schedule_id = ?
       ORDER BY id`
    )
    .all(ledger, eventType, scheduleId) as { id: string; ledger: number }[];
}

/**
 * Validate event data before insertion to catch potential issues early
 */
export function validateEventData(row: InsertEventRow): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!row.id || typeof row.id !== 'string') {
    errors.push('Event ID is required and must be a string');
  }
  
  if (!row.event_type || typeof row.event_type !== 'string') {
    errors.push('Event type is required and must be a string');
  }
  
  if (typeof row.ledger !== 'number' || row.ledger <= 0) {
    errors.push('Ledger must be a positive number');
  }
  
  if (!row.ledger_closed_at || typeof row.ledger_closed_at !== 'string') {
    errors.push('Ledger close time is required and must be a string');
  }
  
  if (!row.raw_topics || typeof row.raw_topics !== 'string') {
    errors.push('Raw topics is required and must be a JSON string');
  }
  
  if (!row.raw_value || typeof row.raw_value !== 'string') {
    errors.push('Raw value is required and must be a JSON string');
  }
  
  // Validate JSON format
  try {
    JSON.parse(row.raw_topics);
  } catch {
    errors.push('Raw topics must be valid JSON');
  }
  
  try {
    JSON.parse(row.raw_value);
  } catch {
    errors.push('Raw value must be valid JSON');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

// ── History ───────────────────────────────────────────────────────────

export interface HistoryQueryParams {
  address: string;
  limit?: number;
  offset?: number;
  /** Asset contract address — maps to the token column. */
  token?: string;
  network?: NetworkName;
}

/**
 * Return paginated claim and revoke events for a grantor/beneficiary address.
 * Results are ordered by ledger descending (most recent first).
 */
export function queryHistory(params: HistoryQueryParams): IndexedEvent[] {
  const db = getDb(params.network);
  const conditions: string[] = [
    "(grantor = ? OR beneficiary = ?)",
    "event_type IN ('claimed', 'revoked')",
  ];
  const values: unknown[] = [params.address, params.address];

  if (params.token) {
    conditions.push("token = ?");
    values.push(params.token);
  }

  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  return db
    .prepare(
      `SELECT * FROM schedule_events WHERE ${conditions.join(" AND ")} ORDER BY ledger DESC LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as IndexedEvent[];
}

/** Query events with optional filters. Results ordered by ledger DESC. */
export function queryEvents(params: EventQueryParams): IndexedEvent[] {
  const db = getDb(params.network);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.address) {
    conditions.push("(grantor = ? OR beneficiary = ?)");
    values.push(params.address, params.address);
  }
  if (params.grantor) {
    conditions.push("grantor = ?");
    values.push(params.grantor);
  }
  if (params.beneficiary) {
    conditions.push("beneficiary = ?");
    values.push(params.beneficiary);
  }
  if (params.event_type) {
    conditions.push("event_type = ?");
    values.push(params.event_type);
  }
  if (params.schedule_id != null) {
    conditions.push("schedule_id = ?");
    values.push(params.schedule_id);
  }
  if (params.from_ledger != null) {
    conditions.push("ledger >= ?");
    values.push(params.from_ledger);
  }
  if (params.to_ledger != null) {
    conditions.push("ledger <= ?");
    values.push(params.to_ledger);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  // Special-case: when requesting created schedules, exclude schedules
  // that have been revoked so paginated results don't contain gaps
  // caused by client-side filtering. Apply the exclusion in SQL so
  // LIMIT/OFFSET operate on the final filtered set.
  if (params.event_type === "schedule_created") {
    const sql = `SELECT * FROM schedule_events ${where}
                 AND schedule_id NOT IN (
                   SELECT schedule_id FROM schedule_events WHERE event_type = 'revoked'
                 )
                 ORDER BY ledger DESC LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...values, limit, offset) as IndexedEvent[];
  }

  return db
    .prepare(
      `SELECT * FROM schedule_events ${where} ORDER BY ledger DESC LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as IndexedEvent[];
}

// ── TVL aggregation ─────────────────────────────────────────────────────

function bigintSum(rows: { value: string | null }[]): bigint {
  return rows.reduce((sum, row) => sum + BigInt(row.value ?? "0"), 0n);
}

export function computeTvlStats(network = parseNetwork(undefined)): TvlStats {
  const db = getDb(network);
  const assets = db
    .prepare(
      `SELECT DISTINCT token AS asset
       FROM schedule_events
       WHERE event_type = 'schedule_created'
         AND token IS NOT NULL
         AND token != ''
       ORDER BY token ASC`
    )
    .all() as { asset: string }[];

  const lastUpdated = Math.floor(Date.now() / 1000);
  const stats = assets.map(({ asset }) => {
    const createdRows = db
      .prepare(
        `SELECT created_amount AS value
         FROM schedule_events
         WHERE event_type = 'schedule_created' AND token = ?`
      )
      .all(asset) as { value: string | null }[];
    const claimedRows = db
      .prepare(
        `SELECT amount AS value
         FROM schedule_events
         WHERE event_type = 'claimed' AND token = ?`
      )
      .all(asset) as { value: string | null }[];
    const revokedRows = db
      .prepare(
        `SELECT json_extract(raw_value, '$[1]') AS value
         FROM schedule_events
         WHERE event_type = 'revoked' AND token = ?`
      )
      .all(asset) as { value: string | null }[];
    const active = db
      .prepare(
        `SELECT COUNT(DISTINCT created.schedule_id) AS count
         FROM schedule_events created
         WHERE created.event_type = 'schedule_created'
           AND created.token = ?
           AND created.schedule_id NOT IN (
             SELECT schedule_id FROM schedule_events WHERE event_type = 'revoked'
           )`
      )
      .get(asset) as { count: number } | undefined;

    const totalCreated = bigintSum(createdRows);
    const totalClaimed = bigintSum(claimedRows);
    const totalRevokedUnvested = bigintSum(revokedRows);
    const tvl = totalCreated - totalClaimed - totalRevokedUnvested;

    const stat = {
      asset,
      total_created: totalCreated.toString(),
      total_claimed: totalClaimed.toString(),
      total_revoked_unvested: totalRevokedUnvested.toString(),
      total_value_locked: (tvl > 0n ? tvl : 0n).toString(),
      active_schedules: active?.count ?? 0,
    };
    db.prepare(
      `INSERT OR REPLACE INTO tvl_stats
       (asset, total_created, total_claimed, total_revoked_unvested,
        total_value_locked, active_schedules, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      stat.asset,
      stat.total_created,
      stat.total_claimed,
      stat.total_revoked_unvested,
      stat.total_value_locked,
      stat.active_schedules,
      lastUpdated
    );
    return stat;
  });

  const total = stats.reduce(
    (sum, asset) => sum + BigInt(asset.total_value_locked),
    0n
  );

  return {
    network,
    assets: stats,
    total_value_locked: total.toString(),
    last_updated: lastUpdated,
  };
}

export function getTvlStats(network = parseNetwork(undefined)): TvlStats {
  const db = getDb(network);
  const rows = db
    .prepare("SELECT * FROM tvl_stats ORDER BY asset ASC")
    .all() as (TvlStats["assets"][number] & { last_updated: number })[];

  if (rows.length === 0) {
    return computeTvlStats(network);
  }

  const total = rows.reduce(
    (sum, row) => sum + BigInt(row.total_value_locked),
    0n
  );

  return {
    network,
    assets: rows.map(({ last_updated: _lastUpdated, ...row }) => row),
    total_value_locked: total.toString(),
    last_updated: Math.max(...rows.map((row) => row.last_updated)),
  };
}

/**
 * Get all unique schedule IDs from events across all networks
 */
export function getAllScheduleIds(): number[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT schedule_id FROM schedule_events WHERE schedule_id IS NOT NULL ORDER BY schedule_id")
    .all() as { schedule_id: number }[];
  return rows.map(r => r.schedule_id);
}

// ── Analytics ──────────────────────────────────────────────────────────

export interface AnalyticsStats {
  total_value_locked: string;
  total_claimed: string;
  active_schedules: number;
  unique_beneficiaries: number;
  total_schedules_created: number;
  total_revoked: number;
  last_updated: number;
}

export interface DailySnapshot {
  date: string;
  total_value_locked: string;
  total_claimed: string;
  active_schedules: number;
  unique_beneficiaries: number;
  total_schedules_created: number;
  total_revoked: number;
}

/**
 * Get current analytics stats from cache
 */
export function getAnalyticsStats(): AnalyticsStats {
  const row = getDb()
    .prepare("SELECT * FROM analytics_cache WHERE id = 1")
    .get() as AnalyticsStats | undefined;
  
  return row || {
    total_value_locked: "0",
    total_claimed: "0",
    active_schedules: 0,
    unique_beneficiaries: 0,
    total_schedules_created: 0,
    total_revoked: 0,
    last_updated: 0,
  };
}

/**
 * Calculate and cache current analytics stats
 */
export function computeAnalyticsStats(): AnalyticsStats {
  const db = getDb();
  
  // Count unique schedule IDs from created events to get total schedules
  const totalCreated = db
    .prepare("SELECT COUNT(DISTINCT schedule_id) as count FROM schedule_events WHERE event_type = 'schedule_created'")
    .get() as { count: number } | undefined;
  
  // Count revoked schedules
  const totalRevoked = db
    .prepare("SELECT COUNT(DISTINCT schedule_id) as count FROM schedule_events WHERE event_type = 'revoked'")
    .get() as { count: number } | undefined;

  // Total claimed across all events
  const totalClaimed = db
    .prepare("SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) as total FROM schedule_events WHERE event_type = 'claimed'")
    .get() as { total: number } | undefined;

  // Count unique beneficiaries
  const uniqueBeneficiaries = db
    .prepare("SELECT COUNT(DISTINCT beneficiary) as count FROM schedule_events WHERE event_type = 'claimed'")
    .get() as { count: number } | undefined;

  const stats: AnalyticsStats = {
    total_value_locked: "0", // This requires on-chain data, will be computed by frontend
    total_claimed: (totalClaimed?.total || 0).toString(),
    active_schedules: 0, // Requires on-chain state check
    unique_beneficiaries: uniqueBeneficiaries?.count || 0,
    total_schedules_created: totalCreated?.count || 0,
    total_revoked: totalRevoked?.count || 0,
    last_updated: Math.floor(Date.now() / 1000),
  };

  // Update cache
  db.prepare(
    `UPDATE analytics_cache SET 
     total_claimed = ?, 
     unique_beneficiaries = ?,
     total_schedules_created = ?,
     total_revoked = ?,
     last_updated = ?
     WHERE id = 1`
  ).run(
    stats.total_claimed,
    stats.unique_beneficiaries,
    stats.total_schedules_created,
    stats.total_revoked,
    stats.last_updated
  );

  return stats;
}

/**
 * Get daily stats snapshots for trend analysis (last N days)
 */
export function getDailyStats(days: number = 30): DailySnapshot[] {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceDate = since.toISOString().split("T")[0];

  return db
    .prepare(
      `SELECT * FROM daily_stats 
       WHERE date >= ? 
       ORDER BY date ASC`
    )
    .all(sinceDate) as DailySnapshot[];
}

/**
 * Record daily snapshot (call once per day)
 */
export function recordDailySnapshot(stats: AnalyticsStats): void {
  const today = new Date().toISOString().split("T")[0];
  
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO daily_stats 
       (date, total_value_locked, total_claimed, active_schedules, unique_beneficiaries, total_schedules_created, total_revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      today,
      stats.total_value_locked,
      stats.total_claimed,
      stats.active_schedules,
      stats.unique_beneficiaries,
      stats.total_schedules_created,
      stats.total_revoked
    );
}

// ── Notifications ──────────────────────────────────────────────────────────

export interface NotificationSubscription {
  id: number;
  email: string;
  schedule_id: number;
  beneficiary_address: string;
  notification_type: string;
  is_active: number;
  verified: number;
  verification_token?: string;
  created_at: number;
  updated_at: number;
}

/**
 * Create a new notification subscription
 */
export function createNotificationSubscription(
  email: string,
  scheduleId: number,
  beneficiaryAddress: string,
  notificationType: string
): NotificationSubscription {
  const verificationToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
  const result = getDb()
    .prepare(
      `INSERT INTO notification_subscriptions (email, schedule_id, beneficiary_address, notification_type, verification_token)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, scheduleId, beneficiaryAddress, notificationType, verificationToken);

  return {
    id: result.lastInsertRowid as number,
    email,
    schedule_id: scheduleId,
    beneficiary_address: beneficiaryAddress,
    notification_type: notificationType,
    is_active: 0,
    verified: 0,
    verification_token: verificationToken,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get a subscription by ID
 */
export function getNotificationSubscription(id: number): NotificationSubscription | null {
  const row = getDb()
    .prepare("SELECT * FROM notification_subscriptions WHERE id = ?")
    .get(id) as NotificationSubscription | undefined;
  return row || null;
}

/**
 * Get subscriptions by email
 */
export function getSubscriptionsByEmail(email: string): NotificationSubscription[] {
  return getDb()
    .prepare("SELECT * FROM notification_subscriptions WHERE email = ? AND is_active = 1")
    .all(email) as NotificationSubscription[];
}

/**
 * Get subscriptions for a schedule
 */
export function getSubscriptionsBySchedule(scheduleId: number): NotificationSubscription[] {
  return getDb()
    .prepare("SELECT * FROM notification_subscriptions WHERE schedule_id = ? AND is_active = 1 AND verified = 1")
    .all(scheduleId) as NotificationSubscription[];
}

/**
 * Verify an email subscription
 */
export function verifyNotificationSubscription(verificationToken: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE notification_subscriptions 
       SET verified = 1, is_active = 1, updated_at = ? 
       WHERE verification_token = ? AND verified = 0`
    )
    .run(Math.floor(Date.now() / 1000), verificationToken);
  return result.changes > 0;
}

/**
 * Unsubscribe from notifications
 */
export function unsubscribeNotifications(id: number): boolean {
  const result = getDb()
    .prepare("UPDATE notification_subscriptions SET is_active = 0, updated_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
}

/**
 * Record a notification event
 */
export function recordNotificationEvent(
  subscriptionId: number,
  eventType: string,
  scheduleId: number,
  status: string = 'sent',
  errorMessage?: string
): void {
  getDb()
    .prepare(
      `INSERT INTO notification_events (subscription_id, event_type, schedule_id, status, error_message)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(subscriptionId, eventType, scheduleId, status, errorMessage || null);
}

/**
 * Check if a milestone has been processed (to avoid duplicates)
 */
export function hasMilestoneBeenProcessed(scheduleId: number, milestoneType: string): boolean {
  const row = getDb()
    .prepare("SELECT id FROM notification_milestones WHERE schedule_id = ? AND milestone_type = ?")
    .get(scheduleId, milestoneType) as { id: number } | undefined;
  return !!row;
}

/**
 * Mark a milestone as processed
 */
export function markMilestoneProcessed(scheduleId: number, milestoneType: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO notification_milestones (schedule_id, milestone_type)
       VALUES (?, ?)`
    )
    .run(scheduleId, milestoneType);
}

// ── Beneficiary Index ─────────────────────────────────────────────────────

/**
 * Insert a beneficiary-schedule mapping into the index table.
 * Called when a schedule_created event is processed.
 */
export function insertBeneficiarySchedule(beneficiary: string, scheduleId: number, network?: NetworkName): void {
  getDb(network)
    .prepare(
      `INSERT OR IGNORE INTO beneficiary_schedules (beneficiary, schedule_id)
       VALUES (?, ?)`
    )
    .run(beneficiary, scheduleId);
}

/**
 * Get all schedule IDs for a beneficiary address using the index.
 * Provides O(1) lookup by leveraging the beneficiary_schedules table.
 */
export function getScheduleIdsByBeneficiary(beneficiary: string, network?: NetworkName): number[] {
  const rows = getDb(network)
    .prepare("SELECT schedule_id FROM beneficiary_schedules WHERE beneficiary = ? ORDER BY created_at DESC")
    .all(beneficiary) as { schedule_id: number }[];
  return rows.map(r => r.schedule_id);
}

// ── Replay Queue Management ───────────────────────────────────────────────

export interface ReplayQueueItem {
  id: number;
  from_ledger: number;
  to_ledger: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  completed_ledger?: number;
  started_at?: number;
  completed_at?: number;
  error_message?: string;
  retry_count: number;
  created_at: number;
  updated_at: number;
}

/**
 * Enqueue a ledger range for replay processing
 */
export function enqueueReplayRange(fromLedger: number, toLedger: number, network?: NetworkName): number {
  const result = getDb(network)
    .prepare(
      `INSERT INTO replay_queue (from_ledger, to_ledger, status)
       VALUES (?, ?, 'pending')`
    )
    .run(fromLedger, toLedger);
  return result.lastInsertRowid as number;
}

/**
 * Get the next pending replay queue item
 */
export function getNextPendingReplay(network?: NetworkName): ReplayQueueItem | null {
  const row = getDb(network)
    .prepare(
      `SELECT * FROM replay_queue 
       WHERE status = 'pending' 
       ORDER BY created_at ASC 
       LIMIT 1`
    )
    .get() as ReplayQueueItem | undefined;
  return row || null;
}

/**
 * Mark a replay range as in progress
 */
export function markReplayInProgress(id: number, network?: NetworkName): void {
  getDb(network)
    .prepare(
      `UPDATE replay_queue 
       SET status = 'in_progress', started_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), id);
}

/**
 * Update replay progress with the last successfully processed ledger
 */
export function updateReplayProgress(id: number, completedLedger: number, network?: NetworkName): void {
  getDb(network)
    .prepare(
      `UPDATE replay_queue 
       SET completed_ledger = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(completedLedger, Math.floor(Date.now() / 1000), id);
}

/**
 * Mark a replay range as completed
 */
export function markReplayCompleted(id: number, network?: NetworkName): void {
  getDb(network)
    .prepare(
      `UPDATE replay_queue 
       SET status = 'completed', completed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), id);
}

/**
 * Mark a replay range as failed
 */
export function markReplayFailed(id: number, errorMessage: string, network?: NetworkName): void {
  getDb(network)
    .prepare(
      `UPDATE replay_queue 
       SET status = 'failed', error_message = ?, completed_at = ?, retry_count = retry_count + 1, updated_at = ?
       WHERE id = ?`
    )
    .run(errorMessage, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), id);
}

/**
 * Get all replay queue items (for monitoring/debugging)
 */
export function getReplayQueueItems(network?: NetworkName): ReplayQueueItem[] {
  return getDb(network)
    .prepare("SELECT * FROM replay_queue ORDER BY created_at DESC")
    .all() as ReplayQueueItem[];
}

/**
 * Get count of pending replay ranges
 */
export function getPendingReplayCount(network?: NetworkName): number {
  const row = getDb(network)
    .prepare("SELECT COUNT(*) as count FROM replay_queue WHERE status = 'pending'")
    .get() as { count: number } | undefined;
  return row?.count || 0;
}

/**
 * Clean up completed and old failed replay entries (housekeeping)
 */
export function cleanupReplayQueue(daysToKeep: number = 7, network?: NetworkName): void {
  const cutoff = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 60 * 60);
  getDb(network)
    .prepare(
      `DELETE FROM replay_queue 
       WHERE (status = 'completed' OR status = 'failed') 
       AND completed_at < ?`
    )
    .run(cutoff);
}

// ── Gap Detection Log ─────────────────────────────────────────────────────

export interface GapDetectionLogEntry {
  id: number;
  last_checkpoint: number;
  current_ledger: number;
  gaps_detected: number;
  checked_at: number;
}

/**
 * Log a gap detection run
 */
export function logGapDetection(
  lastCheckpoint: number, 
  currentLedger: number, 
  gapsDetected: number, 
  network?: NetworkName
): void {
  getDb(network)
    .prepare(
      `INSERT INTO gap_detection_log (last_checkpoint, current_ledger, gaps_detected)
       VALUES (?, ?, ?)`
    )
    .run(lastCheckpoint, currentLedger, gapsDetected);
}

/**
 * Get the most recent gap detection log entry
 */
export function getLastGapDetection(network?: NetworkName): GapDetectionLogEntry | null {
  const row = getDb(network)
    .prepare(
      `SELECT * FROM gap_detection_log 
       ORDER BY checked_at DESC 
       LIMIT 1`
    )
    .get() as GapDetectionLogEntry | undefined;
  return row || null;
}
