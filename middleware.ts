import { NextRequest, NextResponse } from "next/server";

const REQUEST_START_HEADER = "x-request-start";
const REQUEST_ID_HEADER = "x-request-id";

const EXCLUDED_PATHS = ["/api/health", "/api/ready"];

function shouldExclude(pathname: string): boolean {
  return EXCLUDED_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (shouldExclude(pathname)) {
    return NextResponse.next();
  }

  // Echo client-sent X-Request-ID or generate a new one
  const requestId =
    request.headers.get(REQUEST_ID_HEADER) || generateRequestId();
  const startMs = Date.now();

  const response = NextResponse.next({
    request: {
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        [REQUEST_ID_HEADER]: requestId,
        [REQUEST_START_HEADER]: String(startMs),
      },
    },
  });

  // Set X-Request-ID on the response so the client can correlate
  response.headers.set(REQUEST_ID_HEADER, requestId);

  return response;
}

export const config = {
  matcher: "/api/:path*",
};
