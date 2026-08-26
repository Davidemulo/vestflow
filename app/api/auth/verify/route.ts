import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/indexer/src/db";
import { verifyFreighterSignature, isValidStellarAddress } from "@/lib/stellar-verify";
import { generateJWT } from "@/lib/jwt";
import { withLogging } from "@/lib/requestLogger";

const NONCE_VALIDITY_MS = 5 * 60 * 1000; // 5 minutes (must match nonce generation)

/**
 * POST /api/auth/verify
 * Verifies a wallet signature and issues a JWT token.
 */
export const POST = withLogging(async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { publicKey, nonce, signedMessage } = body;

    // Validate inputs
    if (
      !publicKey ||
      !nonce ||
      !signedMessage ||
      typeof publicKey !== "string" ||
      typeof nonce !== "string" ||
      typeof signedMessage !== "string"
    ) {
      return NextResponse.json(
        { error: "publicKey, nonce, and signedMessage are required" },
        { status: 400 }
      );
    }

    // Validate Stellar address
    if (!isValidStellarAddress(publicKey)) {
      return NextResponse.json(
        { error: "Invalid Stellar address format" },
        { status: 400 }
      );
    }

    const db = getDb();

    // Retrieve nonce from database
    const nonceRecord = db
      .prepare("SELECT * FROM nonces WHERE nonce = ? AND public_key = ?")
      .get(nonce, publicKey) as
      | { nonce: string; public_key: string; expires_at: string; created_at: string }
      | undefined;

    if (!nonceRecord) {
      return NextResponse.json(
        { error: "Nonce not found or does not match public key" },
        { status: 400 }
      );
    }

    // Check if nonce has expired
    const expiresAt = new Date(nonceRecord.expires_at).getTime();
    if (Date.now() > expiresAt) {
      // Clean up expired nonce
      db.prepare("DELETE FROM nonces WHERE nonce = ?").run(nonce);
      return NextResponse.json(
        { error: "Nonce has expired" },
        { status: 400 }
      );
    }

    // Verify signature
    const isValidSignature = verifyFreighterSignature(publicKey, nonce, signedMessage);
    if (!isValidSignature) {
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      );
    }

    // Clean up the used nonce
    db.prepare("DELETE FROM nonces WHERE nonce = ?").run(nonce);

    // Generate JWT token
    const token = generateJWT(publicKey);
    const expiresIn = Math.floor(((process.env.JWT_EXPIRY_SECONDS || "3600") as any) as number);

    return NextResponse.json(
      {
        token,
        expiresIn,
        publicKey,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error verifying signature:", error);
    return NextResponse.json(
      { error: "Failed to verify signature" },
      { status: 500 }
    );
  }
});
