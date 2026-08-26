// Builds valid XDR payloads (via the real @stellar/stellar-sdk XDR types, so
// the app's own parsers accept them) to stub Soroban RPC + Freighter for the
// bulk-create e2e test, without touching a live network or a real wallet.
import type { Page, Route } from "@playwright/test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

export const MOCK_KEYPAIR = Keypair.random();
export const MOCK_PUBLIC_KEY = MOCK_KEYPAIR.publicKey();

function accountLedgerEntryXdr(publicKey: string, seq: string): string {
  const entry = new xdr.AccountEntry({
    accountId: Keypair.fromPublicKey(publicKey).xdrAccountId(),
    balance: xdr.Int64.fromString("10000000000000"), // 1,000,000 XLM
    // xdr.SequenceNumber isn't in this SDK version's TS types but exists at runtime (alias for Hyper).
    seqNum: (xdr as any).SequenceNumber.fromString(seq),
    numSubEntries: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    thresholds: Buffer.from([1, 0, 0, 0]),
    signers: [],
    ext: new xdr.AccountEntryExt(0),
  });
  return xdr.LedgerEntryData.account(entry).toXDR("base64");
}

function emptySorobanTransactionDataXdr(resourceFee: string): string {
  const data = new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: 0,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: xdr.Int64.fromString(resourceFee),
  });
  return new SorobanDataBuilder(data).build().toXDR("base64");
}

function u64ScVal(value: number): xdr.ScVal {
  return xdr.ScVal.scvU64(new xdr.Uint64(value));
}

function i128ScVal(value: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString(value.toString()) })
  );
}

/** Picks the retval to hand back from a mocked simulateTransaction/getTransaction based on the invoked contract method. */
function retvalFor(functionName: string, scheduleId: number): xdr.ScVal {
  if (functionName === "balance") return i128ScVal(1_000_000_0000000n); // 1,000,000 XLM — always fundable
  if (functionName === "create_schedule") return u64ScVal(scheduleId);
  return xdr.ScVal.scvVoid();
}

function invokedFunctionName(envelopeXdrBase64: string): string {
  try {
    const tx = TransactionBuilder.fromXDR(envelopeXdrBase64, Networks.TESTNET) as Transaction;
    const op = tx.operations[0] as unknown as { func: xdr.HostFunction };
    return op.func.invokeContract().functionName().toString();
  } catch {
    return "";
  }
}

function successTransactionResultXdr(feeCharged: string): string {
  const opResult = xdr.OperationResult.opInner(
    xdr.OperationResultTr.invokeHostFunction(
      xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(xdr.Hash.fromXDR(Buffer.alloc(32)))
    )
  );
  const result = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString(feeCharged),
    result: xdr.TransactionResultResult.txSuccess([opResult]),
    ext: new xdr.TransactionResultExt(0),
  });
  return result.toXDR("base64");
}

function sorobanTransactionMetaXdr(returnValue: xdr.ScVal): string {
  const meta = new xdr.TransactionMeta(
    3,
    new xdr.TransactionMetaV3({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: new xdr.SorobanTransactionMeta({
        ext: new xdr.SorobanTransactionMetaExt(0),
        events: [],
        returnValue,
        diagnosticEvents: [],
      }),
    })
  );
  return meta.toXDR("base64");
}

let staticEnvelopeXdr = "";
function anyEnvelopeXdr(): string {
  if (staticEnvelopeXdr) return staticEnvelopeXdr;
  const account = new Account(MOCK_PUBLIC_KEY, "1");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "1" }))
    .setTimeout(30)
    .build();
  staticEnvelopeXdr = tx.toXDR();
  return staticEnvelopeXdr;
}

let seq = 0;
let lastFunctionName = "";

/**
 * Registers a page.route() handler that stubs the Soroban RPC endpoint the
 * app talks to (getAccount → getLedgerEntries, simulateTransaction,
 * sendTransaction, getTransaction), plus a REQUEST_ACCESS/REQUEST_PUBLIC_KEY/
 * SUBMIT_TRANSACTION Freighter bridge injected via addInitScript, so
 * "create_schedule" calls succeed against the running dev server without a
 * real wallet extension or real testnet traffic.
 */
export async function mockFreighterAndRpc(page: Page, rpcUrlPattern: string) {
  await page.addInitScript(
    ({ publicKey }) => {
      (window as unknown as { freighter: boolean }).freighter = true;
      window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
        const respond = (payload: Record<string, unknown>) => {
          window.postMessage(
            { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: data.messageId, ...payload },
            window.location.origin
          );
        };
        if (data.type === "REQUEST_ACCESS" || data.type === "REQUEST_PUBLIC_KEY") {
          respond({ publicKey });
        } else if (data.type === "REQUEST_CONNECTION_STATUS") {
          respond({ isConnected: true });
        } else if (data.type === "SUBMIT_TRANSACTION") {
          // No real signature is applied — the mocked RPC below accepts any
          // envelope unconditionally, so a pass-through XDR is sufficient.
          respond({ signedTransaction: data.transactionXdr, signerAddress: publicKey });
        }
      });
    },
    { publicKey: MOCK_PUBLIC_KEY }
  );

  await page.route(rpcUrlPattern, async (route: Route) => {
    const body = route.request().postDataJSON() as {
      id: number;
      method: string;
      params?: { keys?: string[]; transaction?: string; hash?: string };
    };
    const { id, method, params } = body;
    const respond = (result: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result }) });

    switch (method) {
      case "getLedgerEntries": {
        const key = params?.keys?.[0] ?? "";
        return respond({
          latestLedger: 1000,
          entries: [
            { key, xdr: accountLedgerEntryXdr(MOCK_PUBLIC_KEY, String(100 + seq)), lastModifiedLedgerSeq: 999 },
          ],
        });
      }
      case "simulateTransaction": {
        seq++;
        lastFunctionName = params?.transaction ? invokedFunctionName(params.transaction) : "";
        return respond({
          latestLedger: 1000,
          minResourceFee: "50000",
          transactionData: emptySorobanTransactionDataXdr("50000"),
          results: [{ auth: [], xdr: retvalFor(lastFunctionName, seq).toXDR("base64") }],
          cost: { cpuInsns: "0", memBytes: "0" },
          events: [],
        });
      }
      case "sendTransaction": {
        return respond({
          status: "PENDING",
          hash: seq.toString(16).padStart(64, "0"),
          latestLedger: 1000,
          latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)),
        });
      }
      case "getTransaction": {
        return respond({
          status: "SUCCESS",
          latestLedger: 1001,
          latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)),
          oldestLedger: 1,
          oldestLedgerCloseTime: "0",
          ledger: 1000,
          createdAt: String(Math.floor(Date.now() / 1000)),
          applicationOrder: 1,
          feeBump: false,
          envelopeXdr: anyEnvelopeXdr(),
          resultXdr: successTransactionResultXdr("50100"),
          resultMetaXdr: sorobanTransactionMetaXdr(retvalFor(lastFunctionName, seq)),
        });
      }
      default:
        return respond({});
    }
  });
}
