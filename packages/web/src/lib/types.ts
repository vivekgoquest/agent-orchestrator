/**
 * Dashboard-specific types for the web UI.
 *
 * Core types (SessionStatus, ActivityState, CIStatus, ReviewDecision, etc.)
 * are re-exported from @agent-orchestrator/core. Dashboard-specific types
 * extend/flatten the core types for client-side rendering (e.g. DashboardPR
 * flattens core PRInfo + MergeReadiness + CICheck[] + ReviewComment[]).
 */

// Re-export core types used directly by the dashboard
export type {
  SessionStatus,
  ActivityState,
  CIStatus,
  ReviewDecision,
  MergeReadiness,
  PRState,
} from "@agent-orchestrator/core";

import type {
  CICheck as CoreCICheck,
  MergeReadiness,
  CIStatus,
  SessionStatus,
  ActivityState,
  ReviewDecision,
} from "@agent-orchestrator/core";

/** Attention zone priority level */
export type AttentionLevel = "urgent" | "action" | "warning" | "ok" | "done";

/**
 * Flattened session for dashboard rendering.
 * Maps to core Session but uses string dates (JSON-serializable for SSR/client boundary)
 * and inlines PR state.
 *
 * TODO: When wiring to real data, add a serialization layer that converts
 * core Session (Date objects) → DashboardSession (string dates).
 */
export interface DashboardSession {
  id: string;
  projectId: string;
  status: SessionStatus;
  activity: ActivityState;
  branch: string | null;
  issueId: string | null;
  summary: string | null;
  createdAt: string;
  lastActivityAt: string;
  pr: DashboardPR | null;
  metadata: Record<string, string>;
}

/**
 * Flattened PR for dashboard rendering.
 * Aggregates core PRInfo + PRState + CICheck[] + MergeReadiness + ReviewComment[].
 */
export interface DashboardPR {
  number: number;
  url: string;
  title: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  isDraft: boolean;
  state: "open" | "merged" | "closed";
  additions: number;
  deletions: number;
  ciStatus: CIStatus;
  ciChecks: DashboardCICheck[];
  reviewDecision: ReviewDecision;
  mergeability: DashboardMergeability;
  unresolvedThreads: number;
  unresolvedComments: DashboardUnresolvedComment[];
}

/**
 * Mirrors core CICheck but omits Date fields (not JSON-serializable).
 * Core CICheck also has conclusion, startedAt, completedAt.
 */
export interface DashboardCICheck {
  name: string;
  status: CoreCICheck["status"];
  url?: string;
}

/**
 * Same shape as core MergeReadiness — re-exported for convenience.
 */
export type DashboardMergeability = MergeReadiness;

export interface DashboardUnresolvedComment {
  url: string;
  path: string;
  author: string;
  body: string;
}

export interface DashboardStats {
  totalSessions: number;
  workingSessions: number;
  openPRs: number;
  needsReview: number;
}

/** SSE snapshot event from /api/events */
export interface SSESnapshotEvent {
  type: "snapshot";
  sessions: Array<{
    id: string;
    status: SessionStatus;
    activity: ActivityState;
    attentionLevel: AttentionLevel;
    lastActivityAt: string;
  }>;
}

/** SSE activity update event from /api/events */
export interface SSEActivityEvent {
  type: "session.activity";
  sessionId: string;
  activity: ActivityState;
  status: SessionStatus;
  attentionLevel: AttentionLevel;
  timestamp: string;
}

/** Union of all SSE events from /api/events */
export type SSEEvent = SSESnapshotEvent | SSEActivityEvent;

/** Determines which attention zone a session belongs to */
export function getAttentionLevel(session: DashboardSession): AttentionLevel {
  // Red zone: URGENT — needs human input
  if (session.activity === "waiting_input" || session.activity === "blocked") {
    return "urgent";
  }
  if (
    session.status === "needs_input" ||
    session.status === "stuck" ||
    session.status === "errored"
  ) {
    return "urgent";
  }

  // Status-based CI/changes states (even without PR data)
  if (session.status === "ci_failed" || session.status === "changes_requested") {
    return "urgent";
  }

  // Grey zone: terminal states
  if (session.status === "merged" || session.status === "killed" || session.status === "cleanup") {
    return "done";
  }

  // Exited agent: only "done" if status is terminal, otherwise urgent (crashed agent)
  if (session.activity === "exited") {
    return "urgent";
  }

  // Status-based mappings for sessions without PR data
  if (session.status === "mergeable" || session.status === "approved") {
    return session.pr ? "action" : "action";
  }
  if (session.status === "review_pending") {
    return "warning";
  }

  // Check PR-related states
  if (session.pr) {
    const pr = session.pr;

    // Grey zone: done
    if (pr.state === "merged" || pr.state === "closed") {
      return "done";
    }

    // Red zone: CI failed, changes requested, or merge conflicts
    if (pr.ciStatus === "failing") {
      return "urgent";
    }
    if (pr.reviewDecision === "changes_requested" || !pr.mergeability.noConflicts) {
      return "urgent";
    }

    // Orange zone: ACTION — PRs ready to merge
    if (pr.mergeability.mergeable) {
      return "action";
    }

    // Yellow zone: WARNING — needs review, auto-fix failed
    if (
      pr.reviewDecision === "pending" ||
      pr.reviewDecision === "none" ||
      pr.unresolvedThreads > 0
    ) {
      return "warning";
    }
  }

  // Green zone: working normally (spawning, working, pr_open with no issues)
  return "ok";
}
