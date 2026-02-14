import { NextResponse } from "next/server";
import { getServices, getSCM, getTracker } from "@/lib/services";
import { sessionToDashboard, enrichSessionPR, enrichSessionIssue, computeStats } from "@/lib/serialize";

/** GET /api/sessions — List all sessions with full state */
export async function GET() {
  try {
    const { config, registry, sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();

    // Filter out special orchestrator session - it's not a worker session
    const workerSessions = coreSessions.filter((s) => s.id !== "orchestrator");
    const dashboardSessions = workerSessions.map(sessionToDashboard);

    // Enrich issue labels using tracker plugin (synchronous)
    workerSessions.forEach((core, i) => {
      if (!dashboardSessions[i].issueUrl) return;
      let project = config.projects[core.projectId];
      if (!project) {
        const entry = Object.entries(config.projects).find(([, p]) =>
          core.id.startsWith(p.sessionPrefix),
        );
        if (entry) project = entry[1];
      }
      if (!project) {
        const firstKey = Object.keys(config.projects)[0];
        if (firstKey) project = config.projects[firstKey];
      }
      const tracker = getTracker(registry, project);
      if (!tracker || !project) return;
      enrichSessionIssue(dashboardSessions[i], tracker, project);
    });

    // Enrich sessions that have PRs with live SCM data (CI, reviews, mergeability)
    const enrichPromises = workerSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();
      // Try explicit projectId, then match by session prefix, then first project
      let project = config.projects[core.projectId];
      if (!project) {
        const projectEntry = Object.entries(config.projects).find(([, p]) =>
          core.id.startsWith(p.sessionPrefix),
        );
        if (projectEntry) project = projectEntry[1];
      }
      if (!project) {
        const firstKey = Object.keys(config.projects)[0];
        if (firstKey) project = config.projects[firstKey];
      }
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(dashboardSessions[i], scm, core.pr);
    });
    await Promise.allSettled(enrichPromises);

    return NextResponse.json({
      sessions: dashboardSessions,
      stats: computeStats(dashboardSessions),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}
