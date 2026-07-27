import { NextRequest, NextResponse } from "next/server";
import { getEndpoint, removeEndpoint } from "@/lib/webhooks";

/**
 * GET /api/webhooks/:id — retrieve a single webhook endpoint (without secret).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const endpoint = getEndpoint(id);
  if (!endpoint) {
    return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    createdAt: endpoint.createdAt,
  });
}

/**
 * DELETE /api/webhooks/:id — unregister a webhook endpoint.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const removed = removeEndpoint(id);
  if (!removed) {
    return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
