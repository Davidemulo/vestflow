/**
 * VestFlow Event Poller
 *
 * Polls the Stellar RPC `getEvents` endpoint for VestFlow contract events,
 * parses them, and persists them to SQLite via db.ts.
 *
 * Runs as a long-lived Node.js process. Designed for:
 *   - Idempotency: duplicate event IDs are silently ignored.
 *   - Replay safety: set START_LEDGER env var to replay from any ledger.
 *   - Failure recovery: checkpoints after each successful batch, so a
 *     crash causes at-most one batch to be re-processed (safe due to
 *     idempotency).
 *   - Pagination: fetches up to 200 events per RPC call and follows
 *     cursor-based pagination until the tip is reached.
 */

import { rpc as StellarRpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import { getCheckpoint, setCheckpoint, insertEvent, computeTvlStats, insertBeneficiarySchedule } from "./db";
import { materialize } from "./analytics";
import { getNetworkConfig, parseNetwork } from "./config";
import { WebhookDeliveryWorker, fanOutEvent } from "./webhook-delivery";
import type { EventType } from "./types";

const NETWORK = parseNetwork(process.env.INDEXER_NETWORK);
const CONFIG = getNetworkConfig(NETWORK);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "10000");
const TVL_COMPUTE_INTERVAL_MS = Number(
  process.env.TVL_COMPUTE_INTERVAL_MS ?? "60000"
);
const START_LEDGER = Number(process.env.START_LEDGER ?? "0");

if (!CONFIG.contractId) {
  throw new Error(`Missing CONTRACT_ID_${NETWORK.toUpperCase()} for ${NETWORK}`);
}

const server = new StellarRpc.Server(CONFIG.rpcUrl);

// ── Parsing helpers ───────────────────────────────────────────────────

function decodeTopics(rawTopics: xdr.ScVal[]): unknown[] {
  return rawTopics.map((t) => {
    try { return scValToNative(t); } catch { return null; }
  });
}

function decodeValue(raw: xdr.ScVal): unknown {
  try { return scValToNative(raw); } catch { return null; }
}

function inferEventType(topics: unknown[]): EventType {
  const tag = topics[0];
  if (tag === "created") return "schedule_created";
  if (tag === "claimed") return "claimed";
  if (tag === "revoked") return "revoked";
  if (tag === "prop_new") return "proposal_created";
  if (tag === "prop_ack") return "proposal_acknowledged";
  if (tag === "prop_act") return "proposal_activated";
  if (tag === "prop_exp") return "proposal_expired";
  return "unknown";
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  try { return String(v); } catch { return null; }
}

/** JSON.stringify does not support bigint values returned by scValToNative. */
function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item
  );
}

/**
 * Decode the event value, which may be an array (from Vec ScVal tuple) or
 * an object with numeric keys. Returns an array for consistent access.
 */
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    // Object with numeric keys, e.g. {"0": ..., "1": ...}
    const keys = Object.keys(v).map(Number).filter((k) => !isNaN(k));
    if (keys.length > 0) {
      keys.sort((a, b) => a - b);
      return keys.map((k) => (v as Record<string, unknown>)[String(k)]);
    }
  }
  return [];
}

// ── Core poll ─────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  const lastLedger = getCheckpoint(NETWORK);

  // On first run START_LEDGER controls the historical replay depth.
  // Subsequent runs resume from the saved checkpoint.
  const startLedger = lastLedger === 0 ? START_LEDGER : lastLedger + 1;

  let cursor: string | undefined;
  let highestLedger = lastLedger;
  let ingested = 0;

  console.log(`[poller] Polling from ledger ${startLedger}…`);

  try {
    do {
      // The SDK typing for getEvents is loose in v15; cast as needed.
      const response: any = await (server as any).getEvents({
        startLedger: cursor ? undefined : startLedger,
        filters: [{ type: "contract", contractIds: [CONFIG.contractId] }],
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });

      const events: any[] = response.events ?? [];

      for (const raw of events) {
        const topics = decodeTopics(raw.topic ?? []);
        const value = decodeValue(raw.value);
        const valueArr = asArray(value);
        const eventType = inferEventType(topics);

        let scheduleId: number | null = null;
        let proposalId: number | null = null;
        let grantor: string | null = null;
        let beneficiary: string | null = null;
        let amount: string | null = null;
        let token: string | null = null;
        let createdAmount: string | null = null;
        let startTime: number | null = null;
        let duration: number | null = null;
        let cliffDuration: number | null = null;
        let vestingKind: string | null = null;

        switch (eventType) {
          case "schedule_created":
            // Current contract: topics ["created", id],
            // value [grantor, beneficiary, token, total_amount, ...].
            // Older deployments used topics ["created", grantor, beneficiary, token],
            // value [id, total_amount]; keep both decoders for replay safety.
            scheduleId = topics[1] != null && !Number.isNaN(Number(topics[1]))
              ? Number(topics[1])
              : valueArr[0] != null ? Number(valueArr[0]) : null;
            grantor = valueArr[0] != null && scheduleId === Number(topics[1])
              ? toStr(valueArr[0])
              : toStr(topics[1]);
            beneficiary = valueArr[1] != null && scheduleId === Number(topics[1])
              ? toStr(valueArr[1])
              : toStr(topics[2]);
            token = valueArr[2] != null && scheduleId === Number(topics[1])
              ? toStr(valueArr[2])
              : toStr(topics[3]);
            createdAmount = valueArr[3] != null && scheduleId === Number(topics[1])
              ? String(valueArr[3])
              : valueArr[1] != null ? String(valueArr[1]) : null;
            // Vesting curve params: only present in the current event shape
            // (grantor, beneficiary, token, total_amount, start_time,
            // duration, cliff_duration, vesting_kind, ...). Older replayed
            // events lack these — the analytics worker falls back to
            // claimed-only accounting when they're null.
            if (scheduleId === Number(topics[1])) {
              startTime = valueArr[4] != null ? Number(valueArr[4]) : null;
              duration = valueArr[5] != null ? Number(valueArr[5]) : null;
              cliffDuration = valueArr[6] != null ? Number(valueArr[6]) : null;
              vestingKind = valueArr[7] != null ? String(valueArr[7]) : null;
            }
            break;
          case "claimed":
            // topics: ["claimed", beneficiary, token]
            // value: [schedule_id, claimable, total_claimed]
            beneficiary = toStr(topics[1]);
            token = toStr(topics[2]);
            scheduleId = valueArr[0] != null ? Number(valueArr[0]) : null;
            amount = valueArr[1] != null ? String(valueArr[1]) : null;
            break;
          case "revoked":
            // topics: ["revoked", grantor, token]
            // value: [schedule_id, unvested, vested]
            grantor = toStr(topics[1]);
            token = toStr(topics[2]);
            scheduleId = valueArr[0] != null ? Number(valueArr[0]) : null;
            break;
          case "proposal_created":
            // topics: ["prop_new", proposal_id]
            // value: [grantor, beneficiary, token, total_amount]
            proposalId = topics[1] != null ? Number(topics[1]) : null;
            grantor = toStr(valueArr[0]);
            beneficiary = toStr(valueArr[1]);
            token = toStr(valueArr[2]);
            createdAmount = valueArr[3] != null ? String(valueArr[3]) : null;
            break;
          case "proposal_acknowledged":
            // topics: ["prop_ack", proposal_id]
            // value: [beneficiary, ledger]
            proposalId = topics[1] != null ? Number(topics[1]) : null;
            beneficiary = toStr(valueArr[0]);
            break;
          case "proposal_activated":
            // topics: ["prop_act", proposal_id]
            // value: schedule_id
            proposalId = topics[1] != null ? Number(topics[1]) : null;
            scheduleId = value != null && !Array.isArray(value)
              ? Number(value)
              : valueArr[0] != null ? Number(valueArr[0]) : null;
            break;
          case "proposal_expired":
            // topics: ["prop_exp", proposal_id]
            // value: expired_by
            proposalId = topics[1] != null ? Number(topics[1]) : null;
            grantor = toStr(Array.isArray(value) || (value && typeof value === "object")
              ? valueArr[0]
              : value);
            break;
        }

        const isNew = insertEvent({
          id: raw.id,
          event_type: eventType,
          ledger: raw.ledger,
          ledger_closed_at: raw.ledgerClosedAt,
          schedule_id: scheduleId,
          proposal_id: proposalId,
          grantor,
          beneficiary,
          amount,
          token,
          created_amount: createdAmount,
          start_time: startTime,
          duration,
          cliff_duration: cliffDuration,
          vesting_kind: vestingKind,
          raw_topics: jsonStringify(topics),
          raw_value: jsonStringify(value),
        }, NETWORK);

        if (isNew) {
          ingested++;
          // Populate beneficiary index for O(1) lookup
          if (eventType === "schedule_created" && beneficiary && scheduleId !== null) {
            insertBeneficiarySchedule(beneficiary, scheduleId, NETWORK);
          }
          // Queue webhook deliveries. This only writes rows — the HTTP
          // requests happen on the delivery worker pool, so a slow or dead
          // subscriber can never stall indexing.
          try {
            fanOutEvent(
              {
                event_id: raw.id,
                event_type: eventType,
                network: NETWORK,
                ledger: raw.ledger,
                ledger_closed_at: raw.ledgerClosedAt,
                schedule_id: scheduleId,
                proposal_id: proposalId,
                grantor,
                beneficiary,
                token,
                amount,
                created_amount: createdAmount,
              },
              NETWORK
            );
          } catch (err) {
            console.error("[poller] Webhook fan-out failed:", err);
          }
        }
        if (raw.ledger > highestLedger) highestLedger = raw.ledger;
      }

      // Checkpoint after each successful page so a mid-batch crash
      // wastes at most one page worth of RPC calls on restart.
      if (highestLedger > lastLedger) {
        setCheckpoint(highestLedger, NETWORK);
      }

      // Follow cursor if we received a full page (more events may exist).
      cursor =
        events.length === 200
          ? events[events.length - 1].pagingToken
          : undefined;
    } while (cursor);

    if (ingested > 0) {
      console.log(
        `[poller] Ingested ${ingested} new event(s). Checkpoint: ledger ${highestLedger}.`
      );
    } else {
      console.log(`[poller] No new events. Checkpoint: ledger ${highestLedger}.`);
    }

    // Fold newly ingested (and any previously unmaterialized, e.g. from a
    // replay) events into the analytics snapshot tables. Cheap no-op when
    // there's nothing pending.
    try {
      const result = materialize(NETWORK);
      if (result.events_processed > 0) {
        console.log(
          `[poller] Analytics: materialized ${result.events_processed} event(s) → ` +
            `${result.schedules_affected} schedule(s), ${result.tokens_affected} token(s), ${result.grantors_affected} grantor(s).`
        );
      }
    } catch (err) {
      console.error("[poller] Analytics materialization failed:", err);
    }
  } catch (err) {
    // Log but do not crash — the loop will retry on the next interval.
    console.error(
      "[poller] Poll failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ── Webhook delivery ──────────────────────────────────────────────────

/**
 * Boots the delivery worker alongside the poller so queued webhooks are
 * sent within a second of being indexed. Disabled when the process has no
 * encryption key (no registration could have been created without one).
 */
function startWebhookWorker(): WebhookDeliveryWorker | null {
  if (process.env.WEBHOOK_DELIVERY_ENABLED === "false") {
    console.log("[poller]   Webhooks : disabled (WEBHOOK_DELIVERY_ENABLED=false)");
    return null;
  }
  if (!process.env.WEBHOOK_ENCRYPTION_KEY) {
    console.log("[poller]   Webhooks : disabled (WEBHOOK_ENCRYPTION_KEY not set)");
    return null;
  }

  const worker = new WebhookDeliveryWorker({ network: NETWORK });
  worker.start();
  console.log(
    `[poller]   Webhooks : delivering with ${worker.concurrency} concurrent senders`
  );

  const shutdown = () => {
    void worker.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return worker;
}

// ── Entry point ───────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log("[poller] VestFlow event indexer starting");
  console.log(`[poller]   Network  : ${NETWORK}`);
  console.log(`[poller]   Contract : ${CONFIG.contractId}`);
  console.log(`[poller]   RPC      : ${CONFIG.rpcUrl}`);
  console.log(`[poller]   Interval : ${POLL_INTERVAL_MS} ms`);
  console.log(`[poller]   TVL job  : every ${TVL_COMPUTE_INTERVAL_MS} ms`);
  console.log(`[poller]   Checkpoint: ledger ${getCheckpoint(NETWORK)}`);

  startWebhookWorker();

  let lastTvlCompute = 0;

  // Poll immediately on start, then on each interval.
  while (true) {
    await poll();
    const now = Date.now();
    if (now - lastTvlCompute >= TVL_COMPUTE_INTERVAL_MS) {
      const tvl = computeTvlStats(NETWORK);
      lastTvlCompute = now;
      console.log(
        `[poller] TVL refreshed for ${tvl.assets.length} asset(s): ${tvl.total_value_locked}`
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

run().catch((err) => {
  console.error("[poller] Fatal error:", err);
  process.exit(1);
});
