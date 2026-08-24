import { Pool, PoolClient, QueryResult } from "pg";
import fs from "fs";
import path from "path";
import type { EventQueryParams, IndexedEvent } from "./types";

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    if (!DB_URL) {
      throw new Error(
        "PostgreSQL connection string not found. Set DATABASE_URL or POSTGRES_URL environment variable."
      );
    }
    pool = new Pool({
      connectionString: DB_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  return pool;
}

export async function initializeSchema(): Promise<void> {
  const migrationsDir = path.join(__dirname, "..", "migrations");
  const files = [
    "001_postgresql_schema.sql",
    "002_proposal_events.sql",
    "003_webhook_system.sql",
    "004_analytics_snapshots.sql",
  ];
  const client = await getPool().connect();
  try {
    for (const file of files) {
      const schema = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query(schema);
    }
  } finally {
    client.release();
  }
}

export async function getCheckpoint(): Promise<number> {
  const result = await getPool().query(
    "SELECT last_ledger FROM checkpoint WHERE id = 1"
  );
  return result.rows[0]?.last_ledger ?? 0;
}

export async function setCheckpoint(ledger: number): Promise<void> {
  await getPool().query(
    "UPDATE checkpoint SET last_ledger = $1, last_updated = NOW() WHERE id = 1",
    [ledger]
  );
}

export interface InsertScheduleRow {
  schedule_id: number;
  grantor: string;
  beneficiary: string;
  token: string;
  total_amount: string;
  claimed: string;
  start_time: number;
  duration: number;
  cliff_duration: number;
  vesting_kind: string;
  revocable: boolean;
  revoked: boolean;
  ledger_created: number;
  ledger_closed_at: string;
}

export async function upsertSchedule(schedule: InsertScheduleRow): Promise<void> {
  await getPool().query(
    `INSERT INTO vesting_schedules 
      (schedule_id, grantor, beneficiary, token, total_amount, claimed, 
       start_time, duration, cliff_duration, vesting_kind, revocable, revoked,
       ledger_created, ledger_closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (schedule_id) DO UPDATE SET
       claimed = EXCLUDED.claimed,
       revoked = EXCLUDED.revoked,
       updated_at = NOW()`,
    [
      schedule.schedule_id,
      schedule.grantor,
      schedule.beneficiary,
      schedule.token,
      schedule.total_amount,
      schedule.claimed,
      schedule.start_time,
      schedule.duration,
      schedule.cliff_duration,
      schedule.vesting_kind,
      schedule.revocable,
      schedule.revoked,
      schedule.ledger_created,
      schedule.ledger_closed_at,
    ]
  );
}

export interface InsertClaimEventRow {
  id: string;
  schedule_id: number;
  beneficiary: string;
  amount: string;
  ledger: number;
  ledger_closed_at: string;
  transaction_hash: string | null;
  raw_topics: string;
  raw_value: string;
}

export async function insertClaimEvent(event: InsertClaimEventRow): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO claim_events 
      (id, schedule_id, beneficiary, amount, ledger, ledger_closed_at, 
       transaction_hash, raw_topics, raw_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.schedule_id,
      event.beneficiary,
      event.amount,
      event.ledger,
      event.ledger_closed_at,
      event.transaction_hash,
      event.raw_topics,
      event.raw_value,
    ]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export interface InsertRevokeEventRow {
  id: string;
  schedule_id: number;
  grantor: string;
  revoked_amount: string;
  ledger: number;
  ledger_closed_at: string;
  transaction_hash: string | null;
  raw_topics: string;
  raw_value: string;
}

export async function insertRevokeEvent(event: InsertRevokeEventRow): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO revoke_events 
      (id, schedule_id, grantor, revoked_amount, ledger, ledger_closed_at, 
       transaction_hash, raw_topics, raw_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.schedule_id,
      event.grantor,
      event.revoked_amount,
      event.ledger,
      event.ledger_closed_at,
      event.transaction_hash,
      event.raw_topics,
      event.raw_value,
    ]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function getScheduleById(scheduleId: number): Promise<any | null> {
  const result = await getPool().query(
    "SELECT * FROM vesting_schedules WHERE schedule_id = $1",
    [scheduleId]
  );
  return result.rows[0] || null;
}

export async function getClaimEventsByScheduleId(scheduleId: number): Promise<any[]> {
  const result = await getPool().query(
    "SELECT * FROM claim_events WHERE schedule_id = $1 ORDER BY ledger DESC",
    [scheduleId]
  );
  return result.rows;
}

export async function getRevokeEventsByScheduleId(scheduleId: number): Promise<any[]> {
  const result = await getPool().query(
    "SELECT * FROM revoke_events WHERE schedule_id = $1 ORDER BY ledger DESC",
    [scheduleId]
  );
  return result.rows;
}

export async function getSchedulesByAddress(address: string): Promise<any[]> {
  const result = await getPool().query(
    `SELECT * FROM vesting_schedules 
     WHERE grantor = $1 OR beneficiary = $1 
     ORDER BY created_at DESC`,
    [address]
  );
  return result.rows;
}

export async function getAllSchedules(): Promise<any[]> {
  const result = await getPool().query(
    "SELECT * FROM vesting_schedules ORDER BY schedule_id DESC"
  );
  return result.rows;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Beneficiary Index ─────────────────────────────────────────────────────

/**
 * Insert a beneficiary-schedule mapping into the index table.
 * Called when a schedule is created.
 */
export async function insertBeneficiarySchedule(beneficiary: string, scheduleId: number): Promise<void> {
  await getPool().query(
    `INSERT INTO beneficiary_schedules (beneficiary, schedule_id)
     VALUES ($1, $2)
     ON CONFLICT (beneficiary, schedule_id) DO NOTHING`,
    [beneficiary, scheduleId]
  );
}

/**
 * Get all schedule IDs for a beneficiary address using the index.
 * Provides O(1) lookup by leveraging the beneficiary_schedules table.
 */
export async function getScheduleIdsByBeneficiary(beneficiary: string): Promise<number[]> {
  const result = await getPool().query(
    "SELECT schedule_id FROM beneficiary_schedules WHERE beneficiary = $1 ORDER BY created_at DESC",
    [beneficiary]
  );
  return result.rows.map((row: any) => row.schedule_id);
}
