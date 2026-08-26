# @drips/stellar-sdk

TypeScript SDK for interacting with the Drips/VestFlow streaming and vesting
contracts on Stellar/Soroban.

## Installation

```bash
npm install @drips/stellar-sdk
# or
pnpm add @drips/stellar-sdk
```

For wallet signing support (browser), also install:

```bash
npm install @stellar/freighter-api
```

## Quick Start

```ts
import { VestflowClient } from "@drips/stellar-sdk";

// Create a client (defaults to testnet)
const client = new VestflowClient({ network: "testnet" });

// Read a schedule
const schedule = await client.getSchedule(1);
console.log(schedule);

// Get all schedules for a grantor
const ids = await client.getSchedulesByGrantor("G...");

// Get claimable amounts for multiple schedules in one call
const amounts = await client.getClaimableBulk(ids);
```

## Write Transactions (Browser + Freighter)

```ts
import { VestflowClient } from "@vestflow/sdk";
import { signTransaction } from "@stellar/freighter-api";

const client = new VestflowClient({ network: "testnet" });

// Create a vesting schedule
const hash = await client.createSchedule(
  {
    grantor: "G...",
    beneficiary: "G...",
    totalAmountXlm: "1000",
    startTime: Math.floor(Date.now() / 1000),
    durationDays: 365,
    cliffDays: 90,
    kind: "LinearWithCliff",
    revocable: true,
  },
  signTransaction
);

// Claim vested tokens
const claimHash = await client.claimVested("G...", scheduleId, signTransaction);

// Revoke a schedule (grantor only)
const revokeHash = await client.revokeSchedule("G...", scheduleId, signTransaction);
```

## Write Transactions (Node.js + Keypair)

```ts
import { VestflowClient } from "@vestflow/sdk";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

const client = new VestflowClient({ network: "testnet" });
const keypair = Keypair.fromSecret("S...");

const nodeSigner = async (xdr: string, opts: { networkPassphrase: string }) => {
  const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
  tx.sign(keypair);
  return tx.toXDR();
};

const hash = await client.createSchedule({ ... }, nodeSigner);
```

### Get active outgoing streams

```ts
// Query the indexer for all active streams opened by an account.
const streams = await client.getStreams("G...");
for (const s of streams) {
  console.log(s.receiver, s.token, s.ratePerSec.toString(), s.maxEndTime);
}
```

### Waiting for a transaction

```ts
import { waitForTransaction, TimeoutError } from "@drips/stellar-sdk";

// Poll the RPC with exponential backoff until the tx settles.
try {
  const result = await waitForTransaction(hash, {
    getTransaction: (h) => server.getTransaction(h),
    timeoutMs: 30_000,
  });
  console.log(result.status); // "SUCCESS"
} catch (err) {
  if (err instanceof TimeoutError) {
    console.error("transaction never confirmed");
  }
}
```

## API Reference

### `new VestflowClient(config?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `network` | `"testnet" \| "mainnet"` | `"testnet"` | Target Stellar network |
| `contractId` | `string` | Deployed testnet ID | Override contract address |
| `rpcUrl` | `string` | Public endpoint | Override Soroban RPC URL |
| `nativeToken` | `string` | Testnet XLM SAC | Override native token SAC |
| `indexerUrl` | `string` | Public indexer | Override the indexer base URL used by `getStreams` |

### Read Methods

| Method | Returns | Description |
|---|---|---|
| `getSchedule(id, publicKey?)` | `Promise<ScheduleData \| null>` | Fetch a schedule by ID |
| `getScheduleCount()` | `Promise<number>` | Total schedules created |
| `getSchedulesByGrantor(address)` | `Promise<number[]>` | Schedule IDs by grantor |
| `getSchedulesByBeneficiary(address)` | `Promise<number[]>` | Schedule IDs by beneficiary |
| `getClaimable(id, publicKey?)` | `Promise<bigint>` | Claimable amount for one schedule |
| `getClaimableBulk(ids, publicKey?)` | `Promise<bigint[]>` | Claimable amounts for multiple schedules |
| `getScheduleBatch(ids, publicKey?)` | `Promise<(ScheduleData \| null)[]>` | Fetch multiple schedules in one call |
| `getRemainingUnvested(id, publicKey?)` | `Promise<bigint>` | Unvested remainder (what a revoke would recover) |
| `getAllSchedules(publicKey?)` | `Promise<ScheduleData[]>` | All schedules |
| `getStreams(account, indexerUrl?)` | `Promise<Stream[]>` | Active outgoing streams for an account |

### Write Methods

| Method | Returns | Description |
|---|---|---|
| `createSchedule(params, signer)` | `Promise<string>` | Create a new vesting schedule |
| `claimVested(publicKey, id, signer)` | `Promise<string>` | Claim vested tokens |
| `revokeSchedule(publicKey, id, signer)` | `Promise<string>` | Revoke a schedule (grantor only) |

### Transaction polling

| Export | Description |
|---|---|
| `waitForTransaction(hash, opts)` | Poll the RPC with exponential backoff (1s, 2s, 4s, 8s…) until the transaction settles; throws `TimeoutError` after `timeoutMs` (default 30s) |
| `TimeoutError` | Error thrown when the wait times out |

### Utilities

| Function | Description |
|---|---|
| `xlmToStroops(amountXlm)` | Convert XLM string to stroops (integer-safe) |
| `stroopsToXlm(stroops)` | Convert stroops to XLM string |
| `truncate(address)` | Shorten a Stellar address for display |
| `vestingProgress(schedule, now)` | Vesting progress percentage (0-100) |
| `formatDate(timestamp)` | Format Unix timestamp as date string |
| `parseContractError(error)` | Map contract error to user-friendly message |

## Building

`npm run build` produces both ESM (`dist/esm/`) and CJS (`dist/cjs/`) bundles
with matching type declarations, ready to publish to npm.

## License

MIT
