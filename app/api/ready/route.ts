import { NextResponse } from "next/server";
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { getCheckpoint } from "@/indexer/src/db";

const RPC_URL = process.env.NEXT_PUBLIC_NETWORK === "mainnet"
  ? "https://mainnet.sorobanrpc.com"
  : "https://soroban-testnet.stellar.org";

export async function GET(): Promise<NextResponse> {
  try {
    const server = new StellarRpc.Server(RPC_URL);
    const latestLedger = await server.getLatestLedger();
    const checkpoint = getCheckpoint();

    const isReady = checkpoint >= latestLedger.sequence;

    if (!isReady) {
      return NextResponse.json(
        {
          ready: false,
          timestamp: new Date().toISOString(),
          message: "Indexer not caught up to latest ledger",
          indexedLedger: checkpoint,
          latestLedger: latestLedger.sequence,
        },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    return NextResponse.json(
      {
        ready: true,
        timestamp: new Date().toISOString(),
        indexedLedger: checkpoint,
        latestLedger: latestLedger.sequence,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    console.error("Readiness check failed:", error);
    return NextResponse.json(
      {
        ready: false,
        timestamp: new Date().toISOString(),
        error: "Failed to check readiness",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }
}
