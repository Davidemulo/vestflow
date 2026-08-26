// ===========================================================================
// VestFlow SDK — Types
// Issue #95: @vestflow/sdk
//
// All public-facing types for the VestFlow vesting protocol.
// ===========================================================================

/**
 * The type of vesting curve applied to a schedule.
 * Mirrors the VestingKind enum in the Soroban contract.
 */
export type VestingKind = "Linear" | "Cliff" | "LinearWithCliff";

/**
 * A vesting schedule that has been revoked by the grantor.
 * `isScheduleRevoked` narrows `ScheduleData` to this type.
 */
export interface RevokedSchedule extends ScheduleData {
  readonly revoked: true;
}

/**
 * Type guard that narrows `ScheduleData` to `RevokedSchedule`.
 *
 * @example
 * if (isScheduleRevoked(schedule)) {
 *   // TypeScript knows schedule.revoked === true here
 * }
 */
export function isScheduleRevoked(s: ScheduleData): s is RevokedSchedule {
  return s.revoked === true;
}

/**
 * A fully parsed vesting schedule returned from the contract.
 */
export interface ScheduleData {
  /** Unique schedule identifier assigned by the contract. */
  id: number;
  /** Stellar address of the account that created this schedule. */
  grantor: string;
  /** Stellar address of the account that receives vested tokens. */
  beneficiary: string;
  /** Stellar Asset Contract address of the vested token. */
  token: string;
  /** Total tokens locked into this schedule (in stroops / base units). */
  total_amount: bigint;
  /** Tokens already claimed by the beneficiary. */
  claimed: bigint;
  /** Unix timestamp when vesting begins. */
  start_time: number;
  /** Vesting duration in seconds. */
  duration: number;
  /** Cliff duration in seconds from start_time. */
  cliff_duration: number;
  /** Vesting curve type. */
  kind: VestingKind;
  /** Whether the grantor can revoke unvested tokens. */
  revocable: boolean;
  /** Whether this schedule has been revoked. */
  revoked: boolean;
  /** Whether this schedule is currently paused. */
  paused: boolean;
  /** Lockup duration in seconds from start_time. */
  lockup_duration: number;
  /** Whether this schedule requires milestones for graded vesting. */
  requires_milestones: boolean;
  /** Timestamp when vested balance was determined after revoke. */
  vested_at_revoke: bigint;
  /** Cumulative time (in seconds) the schedule has been paused. */
  paused_duration: number;
  /** Unix timestamp when the schedule was last paused (0 if not paused). */
  paused_at: number;
}

/**
 * Result returned by {@link VestflowClient.collect}.
 *
 * When there are no claimable tokens the transaction is not submitted:
 * `collected` is `0n` and `txHash` is an empty string.
 */
export interface CollectResult {
  /** Tokens transferred to the beneficiary, in stroops. */
  collected: bigint;
  /** Transaction hash, or an empty string when nothing was collected. */
  txHash: string;
}

/**
 * Configuration for the VestflowClient.
 */
export interface VestflowConfig {
  /**
   * Target Stellar network.
   * @default "testnet"
   */
  network?: "testnet" | "mainnet";
  /**
   * Override the contract ID.
   * Defaults to the deployed testnet contract address.
   */
  contractId?: string;
  /**
   * Override the Soroban RPC URL.
   * Defaults to the public endpoint for the selected network.
   */
  rpcUrl?: string;
  /**
   * Override the native token SAC address.
   * Defaults to the testnet native XLM SAC.
   */
  nativeToken?: string;
  /**
   * Override the indexer service base URL used by methods that read
   * off-chain indexed data (e.g. {@link VestflowConfig}-consuming
   * `getSplits`).
   * Defaults to a local indexer instance.
   */
  indexerUrl?: string;
}

/**
 * Outcome of a submitted and settled write transaction.
 */
export interface TransactionResult {
  /** Transaction hash. */
  hash: string;
  /** Settlement status as reported by the Soroban RPC. */
  status: "SUCCESS" | "FAILED";
}

/**
 * Live streaming balance for an account/token pair, read directly via
 * Soroban simulation rather than from indexed state.
 */
export interface BalanceResult {
  /** Total tokens streamed to the account so far but not yet collected. */
  streamingBalance: bigint;
  /** Portion of the streaming balance currently collectable. */
  collectableAmount: bigint;
  /** Current inbound streaming rate, in base units per second. */
  streamingRatePerSec: bigint;
}

/**
 * A single receiver in a splits configuration.
 */
export interface SplitsReceiver {
  /** Stellar address of the receiver. */
  address: string;
  /** Share of incoming funds this receiver gets, in basis points (out of 10 000). */
  weightBps: number;
}

/**
 * An account's current splits configuration, as returned by the indexer.
 */
export interface SplitsConfig {
  /** Configured receivers. Empty when no splits are configured. */
  receivers: SplitsReceiver[];
  /** Hash identifying this splits configuration, or "" when unconfigured. */
  hash: string;
}

/**
 * Parameters for creating a new vesting schedule.
 */
export interface CreateScheduleParams {
  /** Stellar public key of the grantor (must sign the transaction). */
  grantor: string;
  /** Stellar public key of the beneficiary. */
  beneficiary: string;
  /** Total amount to vest in XLM as a decimal string (converted to stroops internally). */
  totalAmountXlm: string;
  /** Unix timestamp when vesting begins. */
  startTime: number;
  /** Vesting duration in days. */
  durationDays: number;
  /** Cliff duration in days (0 for no cliff). */
  cliffDays: number;
  /** Vesting curve type. */
  kind: VestingKind;
  /** Whether the grantor can revoke unvested tokens. */
  revocable: boolean;
}

/**
 * A single unlock milestone for a graded vesting schedule.
 *
 * `offsetDays` — days after `startTime` when this tranche unlocks.
 * `bps`        — basis points (out of 10 000) of `totalAmountXlm` that unlock.
 *
 * All milestones in a schedule must sum to exactly 10 000 bps.
 */
export interface GradedMilestone {
  /** Days after startTime when this tranche unlocks. */
  offsetDays: number;
  /** Basis points (out of 10 000) of total amount that unlock at this milestone. */
  bps: number;
}

/**
 * Lifecycle of an escrow schedule proposal.
 * Mirrors the ProposalState enum in the Soroban contract.
 */
export type ProposalState =
  | "Pending"
  | "Acknowledged"
  | { tag: "Activated"; scheduleId: number }
  | "Expired";

/**
 * A two-phase escrow proposal returned from the contract.
 */
export interface ScheduleProposal {
  id: number;
  grantor: string;
  beneficiary: string;
  token: string;
  total_amount: bigint;
  start_time: number;
  duration: number;
  cliff_duration: number;
  lockup_duration: number;
  kind: VestingKind;
  revocable: boolean;
  state: ProposalState;
  created_at_ledger: number;
}

/**
 * Parameters for proposing a vesting schedule without transferring tokens.
 */
export interface ProposeScheduleParams extends CreateScheduleParams {
  /** Lockup duration in days. Defaults to 0. Must be >= cliffDays. */
  lockupDays?: number;
}

/**
 * A delegation of claim rights from a schedule's beneficiary to a
 * third-party address, optionally bounded by amount and/or ledger expiry.
 * Mirrors the ClaimDelegation struct in the Soroban contract.
 */
export interface ClaimDelegation {
  /** Address authorized to claim on the beneficiary's behalf. */
  delegate: string;
  /** Maximum total tokens this delegate may ever claim, or null if unlimited. */
  maxAmount: bigint | null;
  /** Ledger sequence after which this delegation can no longer be used to claim, or null if no expiry. */
  expiresAtLedger: number | null;
  /** Tokens already claimed through this delegation. */
  claimedSoFar: bigint;
  /** Whether the beneficiary has revoked this delegation. */
  revoked: boolean;
}

/**
 * Parameters for creating a new graded (percentage-based) vesting schedule.
 */
export interface CreateGradedScheduleParams {
  /** Stellar public key of the grantor (must sign the transaction). */
  grantor: string;
  /** Stellar public key of the beneficiary. */
  beneficiary: string;
  /** Total amount to vest in XLM (converted to stroops internally). */
  totalAmountXlm: number;
  /** Unix timestamp when vesting begins. */
  startTime: number;
  /** Lockup duration in days — tokens are earned but non-transferable until this date. */
  lockupDays: number;
  /** Whether the grantor can revoke unvested tokens. */
  revocable: boolean;
  /**
   * Ordered list of unlock milestones.
   * Must be non-empty and sum to exactly 10 000 bps.
   */
  milestones: GradedMilestone[];
}
