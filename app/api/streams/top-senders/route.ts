import { NextRequest, NextResponse } from "next/server";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";

const rateLimiter = createIpBasedRateLimiter(60 * 1000, 60);

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const token = request.nextUrl.searchParams.get("token");
    const limitStr = request.nextUrl.searchParams.get("limit") || "10";
    const limit = Math.min(Math.max(1, parseInt(limitStr, 10) || 10), 50);

    if (!token) {
      return NextResponse.json(
        { error: "Token parameter is required" },
        { status: 400 }
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const topSenders: Array<{
      account: string;
      total_rate_per_sec: string;
      receiver_count: number;
    }> = [];

    const response = {
      token,
      limit,
      top_senders: topSenders,
      last_updated: now,
    };

    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    console.error("Error fetching top senders:", error);
    return NextResponse.json(
      { error: "Failed to fetch top senders" },
      { status: 500 }
    );
  }
});
