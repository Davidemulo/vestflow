import { NextRequest, NextResponse } from "next/server";
import { verifyJWT } from "@/lib/jwt";

const REQUEST_START_HEADER = "x-request-start";
const REQUEST_ID_HEADER = "x-request-id";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Auth endpoints & public endpoints must stay reachable without a token.
const PUBLIC_PATHS = [
  "/api/auth/nonce",
  "/api/auth/verify",
  "/api/health",
  "/api/ready",
  "/api/lists",
  "/api/schedules",
  "/api/events",
  "/api/contracts",
  "/api/analytics",
  "/api/stats",
  "/api/streams",
  "/api/addresses",
  "/api/openapi"
];

function generateRequestId(): string {
  return crypto.randomUUID();
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) return NextResponse.next();

  const requestId = request.headers.get(REQUEST_ID_HEADER) || generateRequestId();
  const startMs = Date.now();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set(REQUEST_START_HEADER, String(startMs));

  // If write method and not in public path, verify auth
  if (WRITE_METHODS.has(request.method) && !PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    const authHeader = request.headers.get("authorization") || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 });
    }

    const payload = verifyJWT(token);
    if (!payload) {
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
    }

    requestHeaders.set("x-wallet-address", payload.sub);
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: "/api/:path*",
};
