import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

/** GET /api/metrics/summary — task/plan rollups for dashboard analytics */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = {
      projectId: searchParams.get("projectId") ?? undefined,
      planId: searchParams.get("planId") ?? undefined,
      taskId: searchParams.get("taskId") ?? undefined,
      since: searchParams.get("since") ?? undefined,
      until: searchParams.get("until") ?? undefined,
    };

    const { outcomeMetrics } = await getServices();
    const summary = outcomeMetrics.getSummary(query);

    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load outcome metrics summary" },
      { status: 500 },
    );
  }
}
