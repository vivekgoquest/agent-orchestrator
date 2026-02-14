import { notFound } from "next/navigation";
import { getServices, getTracker, getSCM } from "@/lib/services";
import { sessionToDashboard, enrichSessionIssue, enrichSessionPR } from "@/lib/serialize";
import { SessionDetail } from "@/components/SessionDetail";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SessionPage({ params }: Props) {
  const { id } = await params;

  const { config, registry, sessionManager } = await getServices().catch(() => {
    notFound();
    // notFound() throws, so this never runs, but TS needs the return type
    return null as never;
  });

  const coreSession = await sessionManager.get(id);
  if (!coreSession) {
    notFound();
  }

  const dashboardSession = sessionToDashboard(coreSession);

  // Get project config for enrichments
  let project = config.projects[coreSession.projectId];
  if (!project) {
    const entry = Object.entries(config.projects).find(([, p]) =>
      coreSession.id.startsWith(p.sessionPrefix),
    );
    if (entry) project = entry[1];
  }

  // Enrich issue label using tracker plugin
  if (dashboardSession.issueUrl && project) {
    const tracker = getTracker(registry, project);
    if (tracker) {
      enrichSessionIssue(dashboardSession, tracker, project);
    }
  }

  // Enrich PR with live data from SCM
  if (coreSession.pr && project) {
    const scm = getSCM(registry, project);
    if (scm) {
      await enrichSessionPR(dashboardSession, scm, coreSession.pr);
    }
  }

  return <SessionDetail session={dashboardSession} />;
}
