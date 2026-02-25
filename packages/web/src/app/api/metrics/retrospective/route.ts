import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

/** GET /api/metrics/retrospective — generated failure patterns + recommendations */
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
    const report = outcomeMetrics.generateRetrospective(query);

    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load retrospective report" },
      { status: 500 },
    );
  }
}
