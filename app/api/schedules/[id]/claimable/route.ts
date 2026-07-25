import { getClaimable } from "@/lib/stellar";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const scheduleId = parseInt(id, 10);

    if (isNaN(scheduleId)) {
      return NextResponse.json(
        { error: "Invalid schedule ID" },
        { status: 400 }
      );
    }

    const claimable = await getClaimable(scheduleId);

    return NextResponse.json(
      {
        scheduleId,
        claimableAmount: claimable.toString(),
        timestamp: Math.floor(Date.now() / 1000),
      },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching claimable amount:", error);
    return NextResponse.json(
      { error: "Failed to fetch claimable amount" },
      { status: 500 }
    );
  }
}
