/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  SESSION_STATUS,
  PR_STATE,
  CI_STATUS,
  ESCALATION_LEVELS,
  type LifecycleManager,
  type SessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type EventPriority,
  type EscalationLevel,
  type ReactionEscalationState,
  type EscalationHistoryEntry,
  type EscalationTransitionReason,
  type ProjectConfig as _ProjectConfig,
} from "./types.js";
import { readMetadataRaw, updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { buildReactionMessage } from "./reaction-message.js";
import { parseWorkerEvidence, type WorkerEvidenceParseResult } from "./evidence.js";
import type { OutcomeMetricsStore } from "./outcome-metrics.js";

const VERIFIER_ROLE = "verifier";
const REVIEWER_ROLE = "reviewer";
const VERIFIER_STATUS = {
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
} as const;
const REVIEWER_STATUS = {
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
  ESCALATED: "escalated",
} as const;
const REVIEWER_ID_POOL = ["reviewer-alpha", "reviewer-beta", "reviewer-gamma"] as const;

function isVerifierSession(session: Session): boolean {
  return (session.metadata?.["role"] ?? "").toLowerCase() === VERIFIER_ROLE;
}

function isReviewerSession(session: Session): boolean {
  return (session.metadata?.["role"] ?? "").toLowerCase() === REVIEWER_ROLE;
}

function normalizeVerifierVerdict(value: string | undefined): "passed" | "failed" | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["pass", "passed", "ok", "approved", "green"].includes(normalized)) return "passed";
  if (["fail", "failed", "reject", "rejected", "red"].includes(normalized)) return "failed";
  return null;
}

function buildVerifierPrompt(
  worker: Session,
  evidence: WorkerEvidenceParseResult,
): string {
  const tests =
    evidence.testsRun.items.length > 0
      ? evidence.testsRun.items
          .slice(0, 20)
          .map((test) => `- ${test.command} (${test.status})`)
          .join("\n")
      : "- No test runs recorded";
  const changedPaths =
    evidence.changedPaths.items.length > 0
      ? evidence.changedPaths.items.slice(0, 30).map((path) => `- ${path}`).join("\n")
      : "- No changed paths recorded";
  const knownRisks =
    evidence.knownRisks.items.length > 0
      ? evidence.knownRisks.items
          .slice(0, 20)
          .map((risk) => `- ${risk.risk}${risk.mitigation ? ` | mitigation: ${risk.mitigation}` : ""}`)
          .join("\n")
      : "- No known risks reported";

  return [
    "You are the verifier for this worker session.",
    `Worker session: ${worker.id}`,
    `Branch: ${worker.branch ?? "unknown"}`,
    "",
    "Evidence summary:",
    `- Evidence parse status: ${evidence.status}`,
    "- Tests:",
    tests,
    "- Changed paths:",
    changedPaths,
    "- Known risks:",
    knownRisks,
    "",
    "Review the code and evidence. When done, set your metadata with one of:",
    "- verifierVerdict=passed",
    "- verifierVerdict=failed",
    "If failed, also set verifierFeedback with actionable retry instructions for the worker.",
  ].join("\n");
}

function buildVerifierFailureMessage(feedback: string): string {
  return [
    "Verifier failed this handoff.",
    "",
    "Actionable retry instructions:",
    feedback,
    "",
    "Please address each item, update evidence artifacts, and continue implementation.",
  ].join("\n");
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseReviewerSessionIds(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function reviewerIdsForCount(count: number): string[] {
  const bounded = Math.max(1, count);
  const ids = [...REVIEWER_ID_POOL] as string[];
  while (ids.length < bounded) {
    ids.push(`reviewer-${ids.length + 1}`);
  }
  return ids.slice(0, bounded);
}

function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

async function runExecFile(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        stdout: typeof stdout === "string" ? stdout : String(stdout),
        stderr: typeof stderr === "string" ? stderr : String(stderr),
      });
    });
  });
}

function buildReviewerPrompt(
  worker: Session,
  reviewerId: string,
  cycle: number,
  requireEvidence: boolean,
): string {
  const pr = worker.pr;
  const ownerRepo = pr ? `${pr.owner}/${pr.repo}` : "<OWNER/REPO>";
  const prNumber = pr?.number ? String(pr.number) : "<PR_NUMBER>";

  return [
    "You are an autonomous PR reviewer agent.",
    `Reviewer ID: ${reviewerId}`,
    `Cycle: ${cycle}`,
    `Repository: ${ownerRepo}`,
    `PR number: ${prNumber}`,
    "",
    "Goals:",
    "1. Inspect changed files for correctness, edge cases, and regression risk.",
    "2. Run targeted validation commands for touched areas.",
    "3. Decide APPROVE or REJECT.",
    "4. Publish a machine-readable verdict comment for the Reviewer Agent Gate.",
    "",
    "Required process:",
    `- gh pr checkout ${prNumber} --repo ${ownerRepo}`,
    `- gh pr view ${prNumber} --repo ${ownerRepo} --json title,body,files,commits,headRefName,baseRefName`,
    "- Run at least one targeted test/validation command relevant to changed areas.",
    "- If uncertain, REJECT with explicit blockers.",
    "",
    "Verdict command (required):",
    `- AO_REVIEWER_REPO=${ownerRepo} AO_REVIEWER_CYCLE=${cycle} scripts/reviewer-agent-verdict ${prNumber} APPROVE ${reviewerId} "<summary with evidence>"`,
    `- AO_REVIEWER_REPO=${ownerRepo} AO_REVIEWER_CYCLE=${cycle} scripts/reviewer-agent-verdict ${prNumber} REJECT ${reviewerId} "<blockers with evidence>"`,
    requireEvidence
      ? "- Include explicit evidence in your verdict summary (tests run + risk areas reviewed)."
      : "- Include concise rationale in your verdict summary.",
    "",
    "After posting the verdict comment, update session metadata if helper is available:",
    "- update_ao_metadata reviewerVerdict approve|reject",
    "- update_ao_metadata reviewerFeedback \"<same summary>\"",
  ].join("\n");
}

function buildReviewerFailureMessage(feedback: string): string {
  return [
    "Reviewer agents rejected this PR revision.",
    "",
    "Consolidated blocker summary:",
    feedback,
    "",
    "Address all blockers, update tests/evidence, and continue.",
  ].join("\n");
}

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(str: string): number | null {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return null;
  }
}

type NonHumanEscalationLevel = Exclude<EscalationLevel, "human">;

interface ResolvedEscalationPolicy {
  retryCounts: Record<NonHumanEscalationLevel, number>;
  timeThresholdsMs: Record<NonHumanEscalationLevel, number | null>;
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("passed") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed")
  ) {
    return "action";
  }
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
    return "warning";
  }
  return "info";
}

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "working":
      return "session.working";
    case "verifier_pending":
      return "verifier.pending";
    case "verifier_failed":
      return "verifier.failed";
    case "pr_ready":
      return "verifier.passed";
    case "reviewer_pending":
      return "reviewer.pending";
    case "reviewer_failed":
      return "reviewer.failed";
    case "reviewer_passed":
      return "reviewer.passed";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "summary.all_complete":
      return "all-complete";
    default:
      return null;
  }
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  outcomeMetrics?: OutcomeMetricsStore;
}

const ESCALATION_STATE_METADATA_KEY = "escalationState";

/** Track reaction retry/escalation state per session + reaction key. */
interface ReactionTracker {
  escalation: ReactionEscalationState;
  pendingRetry: boolean;
}

function getTrackerKey(sessionId: SessionId, reactionKey: string): string {
  return `${sessionId}:${reactionKey}`;
}

function isEscalationLevel(value: unknown): value is EscalationLevel {
  return typeof value === "string" && ESCALATION_LEVELS.includes(value as EscalationLevel);
}

function parseEscalationStateMap(raw: string | undefined): Record<string, ReactionEscalationState> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ReactionEscalationState> = {};
    for (const [reactionKey, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Partial<ReactionEscalationState>;
      if (
        !isEscalationLevel(candidate.level) ||
        typeof candidate.firstTriggeredAt !== "string" ||
        typeof candidate.levelEnteredAt !== "string" ||
        typeof candidate.lastTriggeredAt !== "string" ||
        typeof candidate.attemptsInLevel !== "number" ||
        typeof candidate.totalAttempts !== "number" ||
        !Array.isArray(candidate.history)
      ) {
        continue;
      }
      const history: EscalationHistoryEntry[] = candidate.history
        .filter((entry): entry is EscalationHistoryEntry => {
          if (!entry || typeof entry !== "object") return false;
          const maybe = entry as Partial<EscalationHistoryEntry>;
          return (
            isEscalationLevel(maybe.from) &&
            isEscalationLevel(maybe.to) &&
            typeof maybe.at === "string" &&
            (maybe.reason === "retry_count" || maybe.reason === "time_threshold") &&
            typeof maybe.attemptsInLevel === "number" &&
            typeof maybe.totalAttempts === "number" &&
            typeof maybe.elapsedMs === "number"
          );
        })
        .map((entry) => ({ ...entry }));
      out[reactionKey] = {
        level: candidate.level,
        firstTriggeredAt: candidate.firstTriggeredAt,
        levelEnteredAt: candidate.levelEnteredAt,
        lastTriggeredAt: candidate.lastTriggeredAt,
        attemptsInLevel: candidate.attemptsInLevel,
        totalAttempts: candidate.totalAttempts,
        history,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function cloneEscalationState(state: ReactionEscalationState): ReactionEscalationState {
  return {
    ...state,
    history: state.history.map((entry) => ({ ...entry })),
  };
}

function createInitialEscalationState(now: Date): ReactionEscalationState {
  const iso = now.toISOString();
  return {
    level: "worker",
    firstTriggeredAt: iso,
    levelEnteredAt: iso,
    lastTriggeredAt: iso,
    attemptsInLevel: 0,
    totalAttempts: 0,
    history: [],
  };
}

function nextEscalationLevel(level: EscalationLevel): EscalationLevel {
  switch (level) {
    case "worker":
      return "verifier";
    case "verifier":
      return "orchestrator";
    case "orchestrator":
      return "human";
    case "human":
      return "human";
  }
}

function parseTimeThresholdMs(value: number | string | undefined): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  }
  if (typeof value === "string") {
    return parseDuration(value);
  }
  return null;
}

function resolveEscalationPolicy(reactionConfig: ReactionConfig): ResolvedEscalationPolicy {
  const retries = reactionConfig.retries;
  const escalateAfter = reactionConfig.escalateAfter;

  const defaultWorkerRetries =
    typeof retries === "number" && Number.isFinite(retries) && retries >= 0 ? retries : 2;

  const retryCounts: Record<NonHumanEscalationLevel, number> = {
    worker: defaultWorkerRetries,
    verifier: 1,
    orchestrator: 1,
  };

  if (typeof escalateAfter === "number" && Number.isFinite(escalateAfter) && escalateAfter >= 0) {
    retryCounts.worker = Math.min(retryCounts.worker, escalateAfter);
  }

  const timeThresholdsMs: Record<NonHumanEscalationLevel, number | null> = {
    worker: typeof escalateAfter === "string" ? parseTimeThresholdMs(escalateAfter) : null,
    verifier: null,
    orchestrator: null,
  };

  const retryOverrides = reactionConfig.escalationPolicy?.retryCounts;
  if (retryOverrides) {
    for (const level of ["worker", "verifier", "orchestrator"] as const) {
      const value = retryOverrides[level];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        retryCounts[level] = value;
      }
    }
  }

  const timeOverrides = reactionConfig.escalationPolicy?.timeThresholds;
  if (timeOverrides) {
    for (const level of ["worker", "verifier", "orchestrator"] as const) {
      const parsed = parseTimeThresholdMs(timeOverrides[level]);
      if (parsed !== null) {
        timeThresholdsMs[level] = parsed;
      }
    }
  }

  return { retryCounts, timeThresholdsMs };
}

function getElapsedMs(sinceIso: string, now: Date): number {
  const start = new Date(sinceIso).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, now.getTime() - start);
}

function applyEscalationTransition(
  state: ReactionEscalationState,
  reason: EscalationTransitionReason,
  now: Date,
): EscalationHistoryEntry | null {
  if (state.level === "human") return null;
  const from = state.level;
  const to = nextEscalationLevel(from);
  const entry: EscalationHistoryEntry = {
    from,
    to,
    at: now.toISOString(),
    reason,
    attemptsInLevel: state.attemptsInLevel,
    totalAttempts: state.totalAttempts,
    elapsedMs: getElapsedMs(state.levelEnteredAt, now),
  };
  state.level = to;
  state.levelEnteredAt = now.toISOString();
  state.attemptsInLevel = 0;
  state.history.push(entry);
  return entry;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, outcomeMetrics } = deps;

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete
  const COMPLETE_STATUSES = new Set<SessionStatus>(["merged", "killed", "done"]);

  function getProjectSessionsDir(projectId: string): string | null {
    const project = config.projects[projectId];
    if (!project) return null;
    return getSessionsDir(config.configPath, project.path);
  }

  function persistEscalationState(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    nextState: ReactionEscalationState | null,
  ): void {
    const sessionsDir = getProjectSessionsDir(projectId);
    if (!sessionsDir) return;
    const existingRaw = readMetadataRaw(sessionsDir, sessionId);
    let stateMap = parseEscalationStateMap(existingRaw?.[ESCALATION_STATE_METADATA_KEY]);
    if (nextState) {
      stateMap[reactionKey] = cloneEscalationState(nextState);
    } else {
      const { [reactionKey]: _removed, ...rest } = stateMap;
      stateMap = rest;
    }
    if (Object.keys(stateMap).length === 0) {
      updateMetadata(sessionsDir, sessionId, { [ESCALATION_STATE_METADATA_KEY]: "" });
      return;
    }
    updateMetadata(sessionsDir, sessionId, {
      [ESCALATION_STATE_METADATA_KEY]: JSON.stringify(stateMap),
    });
  }

  function loadPersistedEscalationState(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
  ): ReactionEscalationState | null {
    const sessionsDir = getProjectSessionsDir(projectId);
    if (!sessionsDir) return null;
    const raw = readMetadataRaw(sessionsDir, sessionId);
    const stateMap = parseEscalationStateMap(raw?.[ESCALATION_STATE_METADATA_KEY]);
    return stateMap[reactionKey] ?? null;
  }

  function getOrCreateTracker(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
  ): ReactionTracker {
    const trackerKey = getTrackerKey(sessionId, reactionKey);
    const existing = reactionTrackers.get(trackerKey);
    if (existing) return existing;

    const persisted = loadPersistedEscalationState(sessionId, projectId, reactionKey);
    const tracker: ReactionTracker = {
      escalation: persisted ?? createInitialEscalationState(new Date()),
      pendingRetry: persisted ? persisted.level !== "human" : false,
    };
    reactionTrackers.set(trackerKey, tracker);
    return tracker;
  }

  function getExistingTracker(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
  ): ReactionTracker | null {
    const trackerKey = getTrackerKey(sessionId, reactionKey);
    const existing = reactionTrackers.get(trackerKey);
    if (existing) return existing;

    const persisted = loadPersistedEscalationState(sessionId, projectId, reactionKey);
    if (!persisted) return null;
    const tracker: ReactionTracker = {
      escalation: persisted,
      pendingRetry: persisted.level !== "human",
    };
    reactionTrackers.set(trackerKey, tracker);
    return tracker;
  }

  function clearTracker(sessionId: SessionId, projectId: string, reactionKey: string): void {
    reactionTrackers.delete(getTrackerKey(sessionId, reactionKey));
    persistEscalationState(sessionId, projectId, reactionKey, null);
  }

  function resolveReactionConfig(
    projectId: string,
    reactionKey: string,
  ): ReactionConfig | null {
    const project = config.projects[projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    const merged = projectReaction ? { ...globalReaction, ...projectReaction } : globalReaction;
    return merged && merged.action ? (merged as ReactionConfig) : null;
  }

  function mergePolicy(): {
    requireReviewerAgentGate: boolean;
    minReviewerAgentApprovals: number;
  } {
    return {
      requireReviewerAgentGate: config.policies?.merge?.requireReviewerAgentGate ?? true,
      minReviewerAgentApprovals: Math.max(
        1,
        config.policies?.merge?.minReviewerAgentApprovals ?? 2,
      ),
    };
  }

  function hasVerifierGate(project: _ProjectConfig): boolean {
    const verifier = project.verifier ?? config.defaults.verifier;
    return Boolean(verifier?.agent || verifier?.runtime);
  }

  function resolveReviewerRole(project: _ProjectConfig): { agent?: string; runtime?: string } {
    return {
      agent: project.reviewer?.agent ?? config.defaults.reviewer?.agent,
      runtime: project.reviewer?.runtime ?? config.defaults.reviewer?.runtime,
    };
  }

  function hasReviewerGate(project: _ProjectConfig): boolean {
    const merge = mergePolicy();
    if (!merge.requireReviewerAgentGate) return false;
    const reviewerPolicy = config.policies?.reviewer;
    if (reviewerPolicy?.enabled === false) return false;
    const reviewer = resolveReviewerRole(project);
    return Boolean(reviewer.agent || reviewer.runtime);
  }

  function reviewerPolicy(): {
    enabled: boolean;
    reviewerCount: number;
    requiredApprovals: number;
    maxCycles: number;
    requireEvidence: boolean;
    verdictChannel: "issue-comments";
    notifyOnPass: boolean;
  } {
    const merge = mergePolicy();
    const configuredCount = config.policies?.reviewer?.reviewerCount ?? 2;
    const requiredApprovals = merge.requireReviewerAgentGate
      ? merge.minReviewerAgentApprovals
      : 0;
    return {
      enabled: config.policies?.reviewer?.enabled ?? true,
      reviewerCount: Math.max(configuredCount, requiredApprovals || 1),
      requiredApprovals,
      maxCycles: config.policies?.reviewer?.maxCycles ?? 3,
      requireEvidence: config.policies?.reviewer?.requireEvidence ?? true,
      verdictChannel: "issue-comments",
      notifyOnPass: config.policies?.reviewer?.notifyOnPass ?? true,
    };
  }

  interface ReviewerVerdictComment {
    reviewerId: string;
    verdict: "approve" | "reject";
    cycle: number | null;
    summary: string;
    evidence: string;
    createdAt: string;
  }

  interface ReviewerVerdictQueryResult {
    comments: ReviewerVerdictComment[];
    fetchError: boolean;
  }

  async function listReviewerVerdictComments(
    session: Session,
  ): Promise<ReviewerVerdictQueryResult> {
    const pr = session.pr;
    if (!pr) return { comments: [], fetchError: false };
    try {
      const { stdout } = await runExecFile("gh", [
        "api",
        "-F",
        "per_page=100",
        `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`,
      ]);
      const parsed = JSON.parse(stdout) as Array<{ body?: string; created_at?: string }>;
      const reviewerRegex = /AO_REVIEWER_ID\s*:\s*([^\n\r]+)/i;
      const verdictRegex = /AO_REVIEWER_VERDICT\s*:\s*(APPROVE|REJECT)/i;
      const cycleRegex = /AO_REVIEWER_CYCLE\s*:\s*(\d+)/i;
      const evidenceRegex = /AO_REVIEWER_EVIDENCE\s*:\s*([^\n\r]+)/i;
      const markerRegex = /^AO_REVIEWER_[A-Z_]+\s*:\s*.*$/gim;
      const results: ReviewerVerdictComment[] = [];
      for (const comment of parsed) {
        const body = comment.body ?? "";
        const reviewerMatch = body.match(reviewerRegex);
        const verdictMatch = body.match(verdictRegex);
        if (!reviewerMatch || !verdictMatch) continue;
        const cycleMatch = body.match(cycleRegex);
        const evidenceMatch = body.match(evidenceRegex);
        const summary = body.replace(markerRegex, "").trim();
        results.push({
          reviewerId: reviewerMatch[1].trim(),
          verdict: verdictMatch[1].toUpperCase() === "APPROVE" ? "approve" : "reject",
          cycle: cycleMatch ? Number.parseInt(cycleMatch[1], 10) : null,
          summary,
          evidence: evidenceMatch?.[1]?.trim() ?? "",
          createdAt: comment.created_at ?? "",
        });
      }
      return { comments: results, fetchError: false };
    } catch {
      return { comments: [], fetchError: true };
    }
  }

  function evidenceFingerprint(evidence: WorkerEvidenceParseResult): string {
    const paths = [
      evidence.commandLog.path,
      evidence.testsRun.path,
      evidence.changedPaths.path,
      evidence.knownRisks.path,
    ].filter(Boolean);

    const parts = paths.map((path) => {
      if (!existsSync(path)) return `${path}:missing`;
      try {
        const stat = statSync(path);
        return `${path}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${path}:unreadable`;
      }
    });
    return parts.join("|");
  }

  async function resolveVerifierGateStatus(
    session: Session,
    project: _ProjectConfig,
    evidence: WorkerEvidenceParseResult,
  ): Promise<SessionStatus | null> {
    if (isVerifierSession(session)) return null;
    if (!hasVerifierGate(project)) return null;

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const verifierAgent = project.verifier?.agent ?? config.defaults.verifier?.agent;
    const verifierRuntime = project.verifier?.runtime ?? config.defaults.verifier?.runtime;
    const verifierSessionId = session.metadata["verifierSessionId"]?.trim();
    const verifierStatus = session.metadata["verifierStatus"]?.trim().toLowerCase();
    const evidenceToken = evidenceFingerprint(evidence);
    const failedToken = session.metadata["verifierFailedEvidenceToken"];

    if (verifierStatus === VERIFIER_STATUS.PASSED) {
      return SESSION_STATUS.PR_READY;
    }

    if (
      verifierStatus === VERIFIER_STATUS.FAILED &&
      failedToken &&
      failedToken === evidenceToken &&
      !verifierSessionId
    ) {
      return SESSION_STATUS.VERIFIER_FAILED;
    }

    if (verifierSessionId) {
      const verifierSession = await sessionManager.get(verifierSessionId).catch(() => null);
      if (!verifierSession) {
        updateMetadata(sessionsDir, session.id, {
          verifierSessionId: "",
          verifierStatus: "",
        });
      } else {
        const verdict = normalizeVerifierVerdict(verifierSession.metadata["verifierVerdict"]);
        const feedback =
          verifierSession.metadata["verifierFeedback"]?.trim() ||
          session.metadata["verifierFeedback"]?.trim() ||
          "";

        if (verdict === "passed") {
          updateMetadata(sessionsDir, session.id, {
            verifierStatus: VERIFIER_STATUS.PASSED,
            verifierFeedback: feedback,
            verifierFailedEvidenceToken: "",
            verifierEvidenceToken: "",
          });
          return SESSION_STATUS.PR_READY;
        }

        if (verdict === "failed") {
          const actionableFeedback =
            feedback ||
            "Verifier rejected the handoff without details. Re-run checks, inspect recent changes, and document concrete failures.";
          const failureSentFor = session.metadata["verifierFailureSentFor"];
          if (failureSentFor !== verifierSession.id) {
            await sessionManager.send(session.id, buildVerifierFailureMessage(actionableFeedback));
          }
          updateMetadata(sessionsDir, session.id, {
            verifierStatus: VERIFIER_STATUS.FAILED,
            verifierFeedback: actionableFeedback,
            verifierSessionId: "",
            verifierFailureSentFor: verifierSession.id,
            verifierFailedEvidenceToken: evidenceToken,
            verifierEvidenceToken: "",
          });
          return SESSION_STATUS.VERIFIER_FAILED;
        }

        if (
          verifierSession.status === SESSION_STATUS.KILLED ||
          verifierSession.status === SESSION_STATUS.ERRORED ||
          verifierSession.status === SESSION_STATUS.TERMINATED
        ) {
          const fallbackFeedback =
            "Verifier session exited before producing a verdict. Re-run implementation checks and retry verifier handoff.";
          updateMetadata(sessionsDir, session.id, {
            verifierStatus: VERIFIER_STATUS.FAILED,
            verifierFeedback: fallbackFeedback,
            verifierSessionId: "",
            verifierFailedEvidenceToken: evidenceToken,
            verifierEvidenceToken: "",
          });
          return SESSION_STATUS.VERIFIER_FAILED;
        }

        return SESSION_STATUS.VERIFIER_PENDING;
      }
    }

    try {
      const verifierSession = await sessionManager.spawn({
        projectId: session.projectId,
        issueId: session.issueId ?? undefined,
        branch: session.branch ?? undefined,
        prompt: buildVerifierPrompt(session, evidence),
        agent: verifierAgent,
        runtime: verifierRuntime,
      });

      updateMetadata(sessionsDir, session.id, {
        verifierSessionId: verifierSession.id,
        verifierStatus: VERIFIER_STATUS.PENDING,
        verifierFeedback: "",
        verifierEvidenceToken: evidenceToken,
        verifierFailedEvidenceToken: "",
      });

      updateMetadata(sessionsDir, verifierSession.id, {
        role: VERIFIER_ROLE,
        verifierFor: session.id,
        verifierStatus: VERIFIER_STATUS.PENDING,
      });

      return SESSION_STATUS.VERIFIER_PENDING;
    } catch {
      updateMetadata(sessionsDir, session.id, {
        verifierStatus: VERIFIER_STATUS.FAILED,
        verifierFeedback:
          "Unable to spawn verifier session automatically. Retry after checking runtime/agent plugin health.",
        verifierFailedEvidenceToken: evidenceToken,
      });
      return SESSION_STATUS.VERIFIER_FAILED;
    }
  }

  async function resolveReviewerGateStatus(
    session: Session,
    project: _ProjectConfig,
    evidence: WorkerEvidenceParseResult | null,
  ): Promise<SessionStatus | null> {
    if (isVerifierSession(session) || isReviewerSession(session)) return null;
    if (!session.pr) return null;
    if (!hasReviewerGate(project)) return null;

    const policy = reviewerPolicy();
    if (!policy.enabled) return null;

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const reviewerRole = resolveReviewerRole(project);
    const reviewerIds = reviewerIdsForCount(policy.reviewerCount);
    const evidenceToken = evidence ? evidenceFingerprint(evidence) : "no-evidence";

    const status = session.metadata["reviewerStatus"]?.trim().toLowerCase() ?? "";
    const currentCycle = parsePositiveInt(session.metadata["reviewerCycle"]) ?? 1;
    const verdictFetchFailures = parsePositiveInt(
      session.metadata["reviewerVerdictFetchFailures"],
    ) ?? 0;
    const failedToken = session.metadata["reviewerFailedEvidenceToken"];
    const passedToken = session.metadata["reviewerEvidenceToken"];

    const reviewerSessionIds = parseReviewerSessionIds(session.metadata["reviewerSessionIds"]);
    const reviewerSessions = await Promise.all(
      reviewerSessionIds.map((id) => sessionManager.get(id).catch(() => null)),
    );
    const terminalStatuses = new Set<SessionStatus>([
      SESSION_STATUS.MERGED,
      SESSION_STATUS.KILLED,
      SESSION_STATUS.CLEANUP,
      SESSION_STATUS.DONE,
      SESSION_STATUS.TERMINATED,
      SESSION_STATUS.ERRORED,
    ]);
    const hasActiveReviewerSessions = reviewerSessions.some(
      (reviewerSession) => reviewerSession && !terminalStatuses.has(reviewerSession.status),
    );
    const allReviewerSessionsTerminal =
      reviewerSessions.length > 0 &&
      reviewerSessions.every(
        (reviewerSession) => !reviewerSession || terminalStatuses.has(reviewerSession.status),
      );

    const verdictQuery = await listReviewerVerdictComments(session);
    const allVerdicts = verdictQuery.comments;
    const cycleVerdicts = allVerdicts.filter(
      (verdict) => verdict.cycle === currentCycle || (verdict.cycle === null && currentCycle === 1),
    );
    const latestVerdictByReviewer = new Map<string, ReviewerVerdictComment>();
    for (const verdict of cycleVerdicts) {
      const existing = latestVerdictByReviewer.get(verdict.reviewerId);
      if (!existing || verdict.createdAt > existing.createdAt) {
        latestVerdictByReviewer.set(verdict.reviewerId, verdict);
      }
    }

    const rejectFindings: string[] = [];
    const approvalSummaries: string[] = [];
    let approvalCount = 0;
    for (const reviewerId of reviewerIds) {
      const verdict = latestVerdictByReviewer.get(reviewerId);
      if (!verdict) continue;
      const hasEvidence =
        !policy.requireEvidence ||
        verdict.evidence.length > 0 ||
        /test|spec|ci|lint|typecheck|integration/i.test(verdict.summary);
      if (verdict.verdict === "reject") {
        rejectFindings.push(`[${reviewerId}] ${verdict.summary || "Rejected without details."}`);
        continue;
      }
      if (!hasEvidence) {
        rejectFindings.push(
          `[${reviewerId}] Approved without required evidence (include tests/risk notes).`,
        );
        continue;
      }
      approvalCount += 1;
      approvalSummaries.push(`[${reviewerId}] ${verdict.summary || "Approved."}`);
    }

    if (
      !verdictQuery.fetchError &&
      rejectFindings.length === 0 &&
      reviewerSessionIds.length > 0 &&
      allReviewerSessionsTerminal &&
      approvalCount < policy.requiredApprovals
    ) {
      rejectFindings.push("Reviewer sessions exited without posting required verdict comments.");
    }

    if (
      verdictQuery.fetchError &&
      (reviewerSessionIds.length > 0 || status === REVIEWER_STATUS.PENDING)
    ) {
      const nextFetchFailureCount = verdictFetchFailures + 1;
      const fetchFailureLimit = Math.max(2, policy.maxCycles);
      if (nextFetchFailureCount >= fetchFailureLimit) {
        const escalationToken = hashText(
          `${session.id}:${currentCycle}:reviewer-fetch:${nextFetchFailureCount}`,
        );
        const escalationMessage =
          `Unable to fetch reviewer verdict comments after ${nextFetchFailureCount} attempt(s). ` +
          "Escalating to human for intervention.";
        if (session.metadata["reviewerFetchEscalationToken"] !== escalationToken) {
          const event = createEvent("reviewer.failed", {
            sessionId: session.id,
            projectId: session.projectId,
            message: escalationMessage,
            data: { cycle: currentCycle, fetchFailures: nextFetchFailureCount },
          });
          await notifyHuman(event, "urgent");
        }
        updateMetadata(sessionsDir, session.id, {
          reviewerStatus: REVIEWER_STATUS.ESCALATED,
          reviewerFeedback: escalationMessage,
          reviewerSessionIds: "",
          reviewerLastSummary: escalationMessage,
          reviewerVerdictFetchFailures: String(nextFetchFailureCount),
          reviewerFetchEscalationToken: escalationToken,
        });
        return SESSION_STATUS.REVIEWER_FAILED;
      }
      updateMetadata(sessionsDir, session.id, {
        reviewerStatus: REVIEWER_STATUS.PENDING,
        reviewerFeedback:
          `Unable to fetch reviewer verdict comments (attempt ${nextFetchFailureCount}/${fetchFailureLimit}); ` +
          "retrying automatically.",
        reviewerVerdictFetchFailures: String(nextFetchFailureCount),
      });
      return SESSION_STATUS.REVIEWER_PENDING;
    }

    if (verdictFetchFailures > 0 || session.metadata["reviewerFetchEscalationToken"]) {
      updateMetadata(sessionsDir, session.id, {
        reviewerVerdictFetchFailures: "",
        reviewerFetchEscalationToken: "",
      });
    }

    if (rejectFindings.length > 0) {
      const consolidatedFeedback = rejectFindings.join("\n");
      const rejectToken = hashText(`${currentCycle}:${evidenceToken}:${consolidatedFeedback}`);

      if (currentCycle >= policy.maxCycles) {
        if (session.metadata["reviewerEscalationToken"] !== rejectToken) {
          const event = createEvent("reviewer.failed", {
            sessionId: session.id,
            projectId: session.projectId,
            message: `Reviewer loop escalated after ${currentCycle} cycle(s): ${consolidatedFeedback}`,
            data: { cycle: currentCycle, reviewerCount: reviewerIds.length },
          });
          await notifyHuman(event, "urgent");
        }
        updateMetadata(sessionsDir, session.id, {
          reviewerStatus: REVIEWER_STATUS.ESCALATED,
          reviewerFeedback: consolidatedFeedback,
          reviewerSessionIds: "",
          reviewerFailedEvidenceToken: evidenceToken,
          reviewerFailureSentFor: rejectToken,
          reviewerLastSummary: consolidatedFeedback,
          reviewerEscalationToken: rejectToken,
          reviewerVerdictFetchFailures: "",
          reviewerFetchEscalationToken: "",
        });
        return SESSION_STATUS.REVIEWER_FAILED;
      }

      if (session.metadata["reviewerFailureSentFor"] !== rejectToken) {
        await sessionManager.send(session.id, buildReviewerFailureMessage(consolidatedFeedback));
      }

      updateMetadata(sessionsDir, session.id, {
        reviewerStatus: REVIEWER_STATUS.FAILED,
        reviewerFeedback: consolidatedFeedback,
        reviewerSessionIds: "",
        reviewerFailedEvidenceToken: evidenceToken,
        reviewerFailureSentFor: rejectToken,
        reviewerLastSummary: consolidatedFeedback,
        reviewerCycle: String(currentCycle + 1),
        reviewerEscalationToken: "",
        reviewerVerdictFetchFailures: "",
        reviewerFetchEscalationToken: "",
      });
      return SESSION_STATUS.REVIEWER_FAILED;
    }

    if (approvalCount >= policy.requiredApprovals) {
      const summary =
        approvalSummaries.join("\n") ||
        `Received ${approvalCount} reviewer approval verdict(s).`;
      updateMetadata(sessionsDir, session.id, {
        reviewerStatus: REVIEWER_STATUS.PASSED,
        reviewerFeedback: summary,
        reviewerSessionIds: "",
        reviewerFailedEvidenceToken: "",
        reviewerEvidenceToken: evidenceToken,
        reviewerLastSummary: summary,
        reviewerEscalationToken: "",
        reviewerVerdictFetchFailures: "",
        reviewerFetchEscalationToken: "",
      });
      return SESSION_STATUS.REVIEWER_PASSED;
    }

    if (
      (status === REVIEWER_STATUS.FAILED || status === REVIEWER_STATUS.ESCALATED) &&
      failedToken &&
      failedToken === evidenceToken &&
      !hasActiveReviewerSessions
    ) {
      return SESSION_STATUS.REVIEWER_FAILED;
    }

    if (status === REVIEWER_STATUS.PASSED && passedToken && passedToken === evidenceToken) {
      return SESSION_STATUS.REVIEWER_PASSED;
    }

    let spawnCycle = currentCycle;
    if (status === REVIEWER_STATUS.PASSED && passedToken && passedToken !== evidenceToken) {
      spawnCycle = currentCycle + 1;
    }
    if (
      (status === REVIEWER_STATUS.FAILED || status === REVIEWER_STATUS.ESCALATED) &&
      failedToken &&
      failedToken !== evidenceToken
    ) {
      spawnCycle = currentCycle;
    }

    if (hasActiveReviewerSessions) {
      return SESSION_STATUS.REVIEWER_PENDING;
    }

    if (spawnCycle > policy.maxCycles) {
      updateMetadata(sessionsDir, session.id, {
        reviewerStatus: REVIEWER_STATUS.ESCALATED,
        reviewerFeedback: `Reached reviewer cycle limit (${policy.maxCycles}).`,
      });
      return SESSION_STATUS.REVIEWER_FAILED;
    }

    try {
      const spawnedSessionIds: string[] = [];
      for (const reviewerId of reviewerIds) {
        const reviewerSession = await sessionManager.spawn({
          projectId: session.projectId,
          issueId: session.issueId ?? undefined,
          branch: session.branch ?? undefined,
          prompt: buildReviewerPrompt(session, reviewerId, spawnCycle, policy.requireEvidence),
          agent: reviewerRole.agent,
          runtime: reviewerRole.runtime,
        });
        spawnedSessionIds.push(reviewerSession.id);

        updateMetadata(sessionsDir, reviewerSession.id, {
          role: REVIEWER_ROLE,
          reviewerFor: session.id,
          reviewerStatus: REVIEWER_STATUS.PENDING,
          reviewerId,
          reviewerCycle: String(spawnCycle),
        });
      }

      updateMetadata(sessionsDir, session.id, {
        reviewerStatus: REVIEWER_STATUS.PENDING,
        reviewerSessionIds: spawnedSessionIds.join(","),
        reviewerCycle: String(spawnCycle),
        reviewerEvidenceToken: evidenceToken,
        reviewerFailedEvidenceToken: "",
        reviewerFailureSentFor: "",
        reviewerFeedback: "",
        reviewerLastSummary: "",
        reviewerEscalationToken: "",
        reviewerVerdictFetchFailures: "",
        reviewerFetchEscalationToken: "",
      });

      return SESSION_STATUS.REVIEWER_PENDING;
    } catch {
      updateMetadata(sessionsDir, session.id, {
        reviewerStatus: REVIEWER_STATUS.FAILED,
        reviewerFeedback:
          "Unable to spawn reviewer sessions automatically. Check reviewer runtime/agent plugin health.",
        reviewerFailedEvidenceToken: evidenceToken,
        reviewerVerdictFetchFailures: "",
        reviewerFetchEscalationToken: "",
      });
      return SESSION_STATUS.REVIEWER_FAILED;
    }
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<SessionStatus> {
    const project = config.projects[session.projectId];
    if (!project) return session.status;
    const roleSession = isVerifierSession(session) || isReviewerSession(session);

    const agentName = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    // 1. Check if runtime is alive
    if (session.runtimeHandle) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
      if (runtime) {
        const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
        if (!alive) return "killed";
      }
    }

    // 2. Parse worker evidence and gate PR readiness behind verifier pass.
    if (!isVerifierSession(session) && !isReviewerSession(session) && !session.pr && session.workspacePath) {
      const evidence = parseWorkerEvidence({
        sessionId: session.id,
        workspacePath: session.workspacePath,
        metadata: session.metadata ?? {},
      });

      if (evidence.status === "complete") {
        const verifierStatus = await resolveVerifierGateStatus(session, project, evidence);
        if (verifierStatus) return verifierStatus;

        if (
          session.status === SESSION_STATUS.SPAWNING ||
          session.status === SESSION_STATUS.WORKING ||
          session.status === SESSION_STATUS.NEEDS_INPUT ||
          session.status === SESSION_STATUS.STUCK
        ) {
          return SESSION_STATUS.DONE;
        }
      }
    }

    // 3. Check agent activity via terminal output + process liveness
    if (agent && session.runtimeHandle) {
      try {
        const runtime = registry.get<Runtime>(
          "runtime",
          project.runtime ?? config.defaults.runtime,
        );
        const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
        // Only trust detectActivity when we actually have terminal output;
        // empty output means the runtime probe failed, not that the agent exited.
        if (terminalOutput) {
          const activity = agent.detectActivity(terminalOutput);
          if (activity === "waiting_input") return "needs_input";

          // Check whether the agent process is still alive. Some agents
          // (codex, aider, opencode) return "active" for any non-empty
          // terminal output, including the shell prompt visible after exit.
          // Checking isProcessRunning for both "idle" and "active" ensures
          // exit detection works regardless of the agent's classifier.
          const processAlive = await agent.isProcessRunning(session.runtimeHandle);
          if (!processAlive) return "killed";
        }
      } catch {
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          session.status === SESSION_STATUS.STUCK ||
          session.status === SESSION_STATUS.NEEDS_INPUT
        ) {
          return session.status;
        }
      }
    }

    // 4. Auto-detect PR by branch if metadata.pr is missing.
    //    This is critical for agents without auto-hook systems (Codex, Aider,
    //    OpenCode) that can't reliably write pr=<url> to metadata on their own.
    if (!roleSession && !session.pr && scm && session.branch) {
      try {
        const detectedPR = await scm.detectPR(session, project);
        if (detectedPR) {
          session.pr = detectedPR;
          // Persist PR URL so subsequent polls don't need to re-query.
          // Don't write status here — step 4 below will determine the
          // correct status (merged, ci_failed, etc.) on this same cycle.
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
        }
      } catch {
        // SCM detection failed — will retry next poll
      }
    }

    // 5. Check PR state if PR exists
    if (!roleSession && session.pr && scm) {
      try {
        const prState = await scm.getPRState(session.pr);
        if (prState === PR_STATE.MERGED) return "merged";
        if (prState === PR_STATE.CLOSED) return "killed";

        // Check CI
        const ciStatus = await scm.getCISummary(session.pr);
        if (ciStatus === CI_STATUS.FAILING) return "ci_failed";

        const reviewerEvidence =
          !isVerifierSession(session) && !isReviewerSession(session) && session.workspacePath
            ? parseWorkerEvidence({
                sessionId: session.id,
                workspacePath: session.workspacePath,
                metadata: session.metadata ?? {},
              })
            : null;
        const reviewerStatus = await resolveReviewerGateStatus(session, project, reviewerEvidence);
        if (reviewerStatus === SESSION_STATUS.REVIEWER_PENDING) return reviewerStatus;
        if (reviewerStatus === SESSION_STATUS.REVIEWER_FAILED) return reviewerStatus;
        const reviewerPassed =
          reviewerStatus === SESSION_STATUS.REVIEWER_PASSED ||
          !hasReviewerGate(project) ||
          isVerifierSession(session) ||
          isReviewerSession(session);

        // Check reviews
        const reviewDecision = await scm.getReviewDecision(session.pr);
        if (reviewDecision === "changes_requested") return "changes_requested";
        if (reviewDecision === "approved") {
          // Check merge readiness
          const mergeReady = await scm.getMergeability(session.pr);
          if (mergeReady.mergeable) {
            const verifierPassed =
              !hasVerifierGate(project) ||
              isVerifierSession(session) ||
              session.metadata["verifierStatus"]?.trim().toLowerCase() === VERIFIER_STATUS.PASSED;
            if (!verifierPassed || !reviewerPassed) return SESSION_STATUS.APPROVED;
            return "mergeable";
          }
          return "approved";
        }

        if (reviewerPassed) {
          const mergeReady = await scm.getMergeability(session.pr);
          const verifierPassed =
            !hasVerifierGate(project) ||
            isVerifierSession(session) ||
            session.metadata["verifierStatus"]?.trim().toLowerCase() === VERIFIER_STATUS.PASSED;
          if (mergeReady.mergeable && verifierPassed) return "mergeable";
          return "approved";
        }

        if (reviewDecision === "pending") return "review_pending";

        return "pr_open";
      } catch {
        // SCM check failed — keep current status
      }
    }

    // 6. Default: if agent is active, it's working
    if (
      session.status === "spawning" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return "working";
    }
    return session.status;
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    session?: Session,
  ): Promise<ReactionResult> {
    const action = reactionConfig.action ?? "notify";
    const policy = resolveEscalationPolicy(reactionConfig);

    async function handleEscalationTransition(
      tracker: ReactionTracker,
      reason: EscalationTransitionReason,
      now: Date,
    ): Promise<EscalationHistoryEntry | null> {
      const entry = applyEscalationTransition(tracker.escalation, reason, now);
      if (!entry) return null;
      persistEscalationState(sessionId, projectId, reactionKey, tracker.escalation);
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated ${entry.from} → ${entry.to}`,
        data: {
          reactionKey,
          from: entry.from,
          to: entry.to,
          reason: entry.reason,
          attemptsInLevel: entry.attemptsInLevel,
          totalAttempts: entry.totalAttempts,
          elapsedMs: entry.elapsedMs,
        },
      });
      if (entry.to === "human") {
        await notifyHuman(event, reactionConfig.priority ?? "urgent");
        tracker.pendingRetry = false;
      }
      return entry;
    }

    switch (action) {
      case "send-to-agent": {
        if (!reactionConfig.message) {
          return {
            reactionType: reactionKey,
            success: false,
            action: "send-to-agent",
            escalated: false,
          };
        }

        const tracker = getOrCreateTracker(sessionId, projectId, reactionKey);
        const now = new Date();
        tracker.escalation.lastTriggeredAt = now.toISOString();

        // Time-based tier promotion applies even without a new failed send.
        if (tracker.escalation.level !== "human") {
          const level = tracker.escalation.level as NonHumanEscalationLevel;
          const thresholdMs = policy.timeThresholdsMs[level];
          if (thresholdMs !== null && getElapsedMs(tracker.escalation.levelEnteredAt, now) > thresholdMs) {
            await handleEscalationTransition(tracker, "time_threshold", now);
          }
        }

        // Human is terminal in the escalation machine.
        if (tracker.escalation.level === "human") {
          persistEscalationState(sessionId, projectId, reactionKey, tracker.escalation);
          return {
            reactionType: reactionKey,
            success: false,
            action: "send-to-agent",
            escalated: true,
            escalationLevel: "human",
          };
        }

        try {
          const project = config.projects[projectId];
          const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
          const runtime = project
            ? registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime)
            : null;
          const message = session
            ? await buildReactionMessage({
                reactionKey,
                fallbackMessage: reactionConfig.message,
                session,
                scm,
                runtime,
              })
            : reactionConfig.message;

          await sessionManager.send(sessionId, message);
          clearTracker(sessionId, projectId, reactionKey);
          return {
            reactionType: reactionKey,
            success: true,
            action: "send-to-agent",
            message,
            escalated: false,
            escalationLevel: tracker.escalation.level,
          };
        } catch {
          tracker.pendingRetry = true;
          tracker.escalation.totalAttempts += 1;
          tracker.escalation.attemptsInLevel += 1;
          tracker.escalation.lastTriggeredAt = now.toISOString();

          const currentLevel = tracker.escalation.level as NonHumanEscalationLevel;
          const retryLimit = policy.retryCounts[currentLevel];
          if (tracker.escalation.attemptsInLevel > retryLimit) {
            await handleEscalationTransition(tracker, "retry_count", now);
          }

          const escalationLevel = tracker.escalation.level as EscalationLevel;
          persistEscalationState(sessionId, projectId, reactionKey, tracker.escalation);
          return {
            reactionType: reactionKey,
            success: false,
            action: "send-to-agent",
            escalated: escalationLevel === "human",
            escalationLevel,
          };
        }
      }

      case "notify": {
        clearTracker(sessionId, projectId, reactionKey);
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
          escalationLevel: "worker",
        };
      }

      case "auto-merge": {
        clearTracker(sessionId, projectId, reactionKey);
        const allowAutoMerge = config.policies?.merge?.allowAutoMerge ?? false;
        if (!allowAutoMerge) {
          const blockedEvent = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' requested auto-merge, but policy disallows it`,
            data: { reactionKey, blockedByPolicy: true },
          });
          await notifyHuman(blockedEvent, "action");
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            message: "Auto-merge blocked by policy",
            escalated: false,
            escalationLevel: "worker",
          };
        }
        // Auto-merge is handled by the SCM plugin
        // For now, just notify
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered auto-merge`,
          data: { reactionKey },
        });
        await notifyHuman(event, "action");
        return {
          reactionType: reactionKey,
          success: true,
          action: "auto-merge",
          escalated: false,
          escalationLevel: "worker",
        };
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
      escalationLevel: "worker",
    };
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch {
          // Notifier failed — not much we can do
        }
      }
    }
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    const newStatus = await determineStatus(session);

    if (newStatus !== oldStatus) {
      // State transition detected
      states.set(session.id, newStatus);

      // Update metadata — session.projectId is the config key (e.g., "my-app")
      const project = config.projects[session.projectId];
      if (project) {
        const sessionsDir = getSessionsDir(config.configPath, project.path);
        updateMetadata(sessionsDir, session.id, { status: newStatus });
      }

      // Persist transition for outcome metrics + retrospective reporting.
      try {
        outcomeMetrics?.recordTransition({
          sessionId: session.id,
          projectId: session.projectId,
          taskId: session.metadata["taskId"] ?? session.issueId ?? session.id,
          planId: session.metadata["planId"] ?? session.metadata["plan"] ?? "default",
          issueId: session.issueId ?? undefined,
          fromStatus: oldStatus,
          toStatus: newStatus,
        });
      } catch {
        // Metrics persistence is best-effort and must not block lifecycle updates.
      }

      // Reset allCompleteEmitted when any session becomes active again
      if (newStatus !== "merged" && newStatus !== "killed") {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          clearTracker(session.id, session.projectId, oldReactionKey);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          const reactionConfig = resolveReactionConfig(session.projectId, reactionKey);
          if (reactionConfig) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const result = await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
                session,
              );
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
              if (reactionConfig.action === "send-to-agent" && result.success) {
                // Successful send-to-agent run is complete. No retries needed.
                clearTracker(session.id, session.projectId, reactionKey);
              }
            }
          }
        }

        // For significant transitions not already notified by a reaction, notify humans
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          if (priority !== "info") {
            const event = createEvent(eventType, {
              sessionId: session.id,
              projectId: session.projectId,
              message: `${session.id}: ${oldStatus} → ${newStatus}`,
              data: { oldStatus, newStatus },
            });
            await notifyHuman(event, priority);
          }
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);

      // Retry send-to-agent reactions even when status remains unchanged.
      // This avoids silent loops where a previous send failed once and then
      // never retried because no further state transitions occurred.
      const currentEventType = statusToEventType(undefined, newStatus);
      if (!currentEventType) return;
      const reactionKey = eventToReactionKey(currentEventType);
      if (!reactionKey) return;

      const reactionConfig = resolveReactionConfig(session.projectId, reactionKey);
      if (!reactionConfig || reactionConfig.action !== "send-to-agent" || reactionConfig.auto === false) {
        return;
      }

      const tracker = getExistingTracker(session.id, session.projectId, reactionKey);
      if (!tracker || !tracker.pendingRetry) return;

      await executeReaction(session.id, session.projectId, reactionKey, reactionConfig, session);
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list();

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (!COMPLETE_STATUSES.has(s.status)) return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Prune stale entries from states and reactionTrackers for sessions
      // that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }

      // Check if all sessions are complete (trigger reaction only once)
      const activeSessions = sessions.filter((s) => !COMPLETE_STATUSES.has(s.status));
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction("system", "all", reactionKey, reactionConfig as ReactionConfig);
            }
          }
        }
      }
    } catch {
      // Poll cycle failed — will retry next interval
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await checkSession(session);
    },
  };
}
