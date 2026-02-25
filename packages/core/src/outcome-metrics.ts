/**
 * Outcome metrics store + retrospective generator.
 *
 * Persists lifecycle transitions to disk and derives:
 * - Task-level metrics (first-pass success, retries, cycle time, reopen count)
 * - Plan-level rollups
 * - A retrospective report with failure patterns + recommendations
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getProjectBaseDir } from "./paths.js";
import type { OrchestratorConfig, SessionId, SessionStatus } from "./types.js";

const TERMINAL_STATUSES = new Set<SessionStatus>([
  "merged",
  "cleanup",
  "done",
  "terminated",
  "killed",
  "errored",
]);

const FAILURE_STATUSES = new Set<SessionStatus>(["ci_failed", "changes_requested", "stuck", "errored"]);

const TRANSITIONS_RELATIVE_PATH = join("metrics", "outcome-transitions.jsonl");

export interface OutcomeTransitionInput {
  sessionId: SessionId;
  projectId: string;
  taskId?: string;
  planId?: string;
  issueId?: string;
  fromStatus: SessionStatus;
  toStatus: SessionStatus;
  timestamp?: string;
}

export interface OutcomeTransitionRecord {
  sessionId: SessionId;
  projectId: string;
  taskId: string;
  planId: string;
  issueId?: string;
  fromStatus: SessionStatus;
  toStatus: SessionStatus;
  timestamp: string;
}

export interface OutcomeMetricsQuery {
  projectId?: string;
  planId?: string;
  taskId?: string;
  since?: string;
  until?: string;
}

export interface TaskOutcomeMetrics {
  projectId: string;
  planId: string;
  taskId: string;
  issueId: string | null;
  sessionIds: string[];
  transitions: number;
  retries: number;
  reopenCount: number;
  failureSignals: number;
  startedAt: string;
  completedAt: string | null;
  cycleTimeMs: number | null;
  firstPassSuccess: boolean | null;
  terminalStatus: SessionStatus | null;
}

export interface PlanOutcomeSummary {
  projectId: string;
  planId: string;
  taskCount: number;
  completedTasks: number;
  firstPassRate: number;
  averageRetries: number;
  averageCycleTimeMs: number | null;
  reopenRate: number;
}

export interface OverallOutcomeSummary {
  taskCount: number;
  completedTasks: number;
  firstPassRate: number;
  averageRetries: number;
  averageCycleTimeMs: number | null;
  reopenRate: number;
}

export interface OutcomeMetricsSummary {
  generatedAt: string;
  filters: OutcomeMetricsQuery;
  transitionCount: number;
  tasks: TaskOutcomeMetrics[];
  plans: PlanOutcomeSummary[];
  overall: OverallOutcomeSummary;
}

export interface RetrospectivePattern {
  id: "retry_churn" | "reopened_work" | "long_cycle_time" | "incomplete_work";
  title: string;
  severity: "low" | "medium" | "high";
  count: number;
  recommendation: string;
}

export interface RetrospectiveReport {
  generatedAt: string;
  filters: OutcomeMetricsQuery;
  overview: OverallOutcomeSummary;
  highlights: string[];
  failurePatterns: RetrospectivePattern[];
  recommendations: string[];
  topSlowTasks: Array<{ projectId: string; planId: string; taskId: string; cycleTimeMs: number }>;
}

export interface OutcomeMetricsStore {
  recordTransition(transition: OutcomeTransitionInput): void;
  listTransitions(query?: OutcomeMetricsQuery): OutcomeTransitionRecord[];
  getSummary(query?: OutcomeMetricsQuery): OutcomeMetricsSummary;
  generateRetrospective(query?: OutcomeMetricsQuery): RetrospectiveReport;
}

interface CreateOutcomeMetricsStoreOptions {
  now?: () => Date;
}

interface TaskAccumulator {
  projectId: string;
  planId: string;
  taskId: string;
  issueId: string | null;
  sessionIds: Set<string>;
  transitions: number;
  retries: number;
  reopenCount: number;
  failureSignals: number;
  startedAtMs: number;
  completedAtMs: number | null;
  terminalStatus: SessionStatus | null;
}

function isFailureStatus(status: SessionStatus): boolean {
  return FAILURE_STATUSES.has(status);
}

function isTerminalStatus(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeDate(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function clampRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function resolveTransitionsPath(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), TRANSITIONS_RELATIVE_PATH);
}

function sortTransitionsByTime(records: OutcomeTransitionRecord[]): OutcomeTransitionRecord[] {
  return records.sort((a, b) => {
    const aMs = Date.parse(a.timestamp);
    const bMs = Date.parse(b.timestamp);
    if (aMs !== bMs) return aMs - bMs;
    if (a.projectId !== b.projectId) return a.projectId.localeCompare(b.projectId);
    if (a.planId !== b.planId) return a.planId.localeCompare(b.planId);
    if (a.taskId !== b.taskId) return a.taskId.localeCompare(b.taskId);
    return a.sessionId.localeCompare(b.sessionId);
  });
}

function computeTaskMetrics(transitions: OutcomeTransitionRecord[]): TaskOutcomeMetrics[] {
  const tasks = new Map<string, TaskAccumulator>();

  for (const transition of transitions) {
    const transitionMs = Date.parse(transition.timestamp);
    if (!Number.isFinite(transitionMs)) continue;

    const key = `${transition.projectId}::${transition.planId}::${transition.taskId}`;
    let accumulator = tasks.get(key);

    if (!accumulator) {
      accumulator = {
        projectId: transition.projectId,
        planId: transition.planId,
        taskId: transition.taskId,
        issueId: transition.issueId ?? null,
        sessionIds: new Set([transition.sessionId]),
        transitions: 0,
        retries: 0,
        reopenCount: 0,
        failureSignals: 0,
        startedAtMs: transitionMs,
        completedAtMs: null,
        terminalStatus: null,
      };
      tasks.set(key, accumulator);
    }

    if (accumulator.issueId === null && transition.issueId) {
      accumulator.issueId = transition.issueId;
    }

    accumulator.transitions += 1;
    accumulator.sessionIds.add(transition.sessionId);
    accumulator.startedAtMs = Math.min(accumulator.startedAtMs, transitionMs);

    if (isFailureStatus(transition.toStatus)) {
      accumulator.failureSignals += 1;
    }

    if (isFailureStatus(transition.fromStatus) && !isFailureStatus(transition.toStatus)) {
      accumulator.retries += 1;
    }

    if (isTerminalStatus(transition.fromStatus) && !isTerminalStatus(transition.toStatus)) {
      accumulator.reopenCount += 1;
    }

    if (isTerminalStatus(transition.toStatus)) {
      accumulator.completedAtMs = transitionMs;
      accumulator.terminalStatus = transition.toStatus;
    }
  }

  return [...tasks.values()]
    .map((task): TaskOutcomeMetrics => {
      const completedAt = task.completedAtMs ? new Date(task.completedAtMs).toISOString() : null;
      const cycleTimeMs =
        task.completedAtMs !== null ? Math.max(task.completedAtMs - task.startedAtMs, 0) : null;
      const firstPassSuccess =
        task.completedAtMs === null
          ? null
          : task.retries === 0 && task.reopenCount === 0 && task.failureSignals === 0;

      return {
        projectId: task.projectId,
        planId: task.planId,
        taskId: task.taskId,
        issueId: task.issueId,
        sessionIds: [...task.sessionIds].sort(),
        transitions: task.transitions,
        retries: task.retries,
        reopenCount: task.reopenCount,
        failureSignals: task.failureSignals,
        startedAt: new Date(task.startedAtMs).toISOString(),
        completedAt,
        cycleTimeMs,
        firstPassSuccess,
        terminalStatus: task.terminalStatus,
      };
    })
    .sort((a, b) => {
      if (a.projectId !== b.projectId) return a.projectId.localeCompare(b.projectId);
      if (a.planId !== b.planId) return a.planId.localeCompare(b.planId);
      return a.taskId.localeCompare(b.taskId);
    });
}

function computePlanSummaries(tasks: TaskOutcomeMetrics[]): PlanOutcomeSummary[] {
  const grouped = new Map<string, TaskOutcomeMetrics[]>();
  for (const task of tasks) {
    const key = `${task.projectId}::${task.planId}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(task);
    grouped.set(key, bucket);
  }

  return [...grouped.entries()]
    .map(([key, planTasks]): PlanOutcomeSummary => {
      const [projectId, planId] = key.split("::");
      const completed = planTasks.filter((task) => task.completedAt !== null);
      const firstPassCompleted = completed.filter((task) => task.firstPassSuccess === true);
      const cycleTimes = completed
        .map((task) => task.cycleTimeMs)
        .filter((value): value is number => value !== null);
      const reopened = planTasks.filter((task) => task.reopenCount > 0);

      return {
        projectId,
        planId,
        taskCount: planTasks.length,
        completedTasks: completed.length,
        firstPassRate: clampRatio(firstPassCompleted.length, completed.length),
        averageRetries: average(planTasks.map((task) => task.retries)),
        averageCycleTimeMs: cycleTimes.length > 0 ? average(cycleTimes) : null,
        reopenRate: clampRatio(reopened.length, planTasks.length),
      };
    })
    .sort((a, b) => {
      if (a.projectId !== b.projectId) return a.projectId.localeCompare(b.projectId);
      return a.planId.localeCompare(b.planId);
    });
}

function computeOverallSummary(tasks: TaskOutcomeMetrics[]): OverallOutcomeSummary {
  const completed = tasks.filter((task) => task.completedAt !== null);
  const firstPassCompleted = completed.filter((task) => task.firstPassSuccess === true);
  const cycleTimes = completed
    .map((task) => task.cycleTimeMs)
    .filter((value): value is number => value !== null);
  const reopened = tasks.filter((task) => task.reopenCount > 0);

  return {
    taskCount: tasks.length,
    completedTasks: completed.length,
    firstPassRate: clampRatio(firstPassCompleted.length, completed.length),
    averageRetries: average(tasks.map((task) => task.retries)),
    averageCycleTimeMs: cycleTimes.length > 0 ? average(cycleTimes) : null,
    reopenRate: clampRatio(reopened.length, tasks.length),
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(1, fraction));
  const index = Math.floor((sorted.length - 1) * clamped);
  return sorted[index] ?? null;
}

export function createOutcomeMetricsStore(
  config: OrchestratorConfig,
  options?: CreateOutcomeMetricsStoreOptions,
): OutcomeMetricsStore {
  const now = options?.now ?? (() => new Date());

  function listTransitions(query?: OutcomeMetricsQuery): OutcomeTransitionRecord[] {
    const sinceMs = normalizeDate(query?.since);
    const untilMs = normalizeDate(query?.until);

    const projectIds = query?.projectId
      ? query.projectId in config.projects
        ? [query.projectId]
        : []
      : Object.keys(config.projects);

    const records: OutcomeTransitionRecord[] = [];

    for (const projectId of projectIds) {
      const project = config.projects[projectId];
      if (!project) continue;

      const transitionsPath = resolveTransitionsPath(config.configPath, project.path);
      if (!existsSync(transitionsPath)) continue;

      const content = readFileSync(transitionsPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed) as Partial<OutcomeTransitionRecord>;
          if (
            typeof parsed.sessionId !== "string" ||
            typeof parsed.projectId !== "string" ||
            typeof parsed.taskId !== "string" ||
            typeof parsed.planId !== "string" ||
            typeof parsed.fromStatus !== "string" ||
            typeof parsed.toStatus !== "string" ||
            typeof parsed.timestamp !== "string"
          ) {
            continue;
          }

          const timestampMs = Date.parse(parsed.timestamp);
          if (!Number.isFinite(timestampMs)) continue;
          if (sinceMs !== null && timestampMs < sinceMs) continue;
          if (untilMs !== null && timestampMs > untilMs) continue;
          if (query?.planId && parsed.planId !== query.planId) continue;
          if (query?.taskId && parsed.taskId !== query.taskId) continue;

          records.push({
            sessionId: parsed.sessionId,
            projectId: parsed.projectId,
            taskId: parsed.taskId,
            planId: parsed.planId,
            issueId: typeof parsed.issueId === "string" ? parsed.issueId : undefined,
            fromStatus: parsed.fromStatus as SessionStatus,
            toStatus: parsed.toStatus as SessionStatus,
            timestamp: parsed.timestamp,
          });
        } catch {
          // Skip malformed lines to keep reads resilient.
        }
      }
    }

    return sortTransitionsByTime(records);
  }

  return {
    recordTransition(transition: OutcomeTransitionInput): void {
      const project = config.projects[transition.projectId];
      if (!project) return;

      const timestamp = transition.timestamp ?? now().toISOString();
      const record: OutcomeTransitionRecord = {
        sessionId: transition.sessionId,
        projectId: transition.projectId,
        taskId: transition.taskId ?? transition.issueId ?? transition.sessionId,
        planId: transition.planId ?? "default",
        issueId: transition.issueId,
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        timestamp,
      };

      const transitionsPath = resolveTransitionsPath(config.configPath, project.path);
      mkdirSync(dirname(transitionsPath), { recursive: true });
      appendFileSync(transitionsPath, `${JSON.stringify(record)}\n`, "utf-8");
    },

    listTransitions,

    getSummary(query?: OutcomeMetricsQuery): OutcomeMetricsSummary {
      const transitions = listTransitions(query);
      const tasks = computeTaskMetrics(transitions);
      const plans = computePlanSummaries(tasks);

      return {
        generatedAt: now().toISOString(),
        filters: query ?? {},
        transitionCount: transitions.length,
        tasks,
        plans,
        overall: computeOverallSummary(tasks),
      };
    },

    generateRetrospective(query?: OutcomeMetricsQuery): RetrospectiveReport {
      const summary = this.getSummary(query);
      const tasks = summary.tasks;

      const completed = tasks.filter((task) => task.completedAt !== null);
      const retryChurnCount = tasks.filter((task) => task.retries > 0).length;
      const reopenedCount = tasks.filter((task) => task.reopenCount > 0).length;
      const incompleteCount = tasks.filter((task) => task.completedAt === null).length;

      const cycleTimes = completed
        .map((task) => task.cycleTimeMs)
        .filter((value): value is number => value !== null);
      const slowThreshold = percentile(cycleTimes, 0.75);
      const slowTasks = tasks
        .filter(
          (task) =>
            task.cycleTimeMs !== null && slowThreshold !== null && task.cycleTimeMs >= slowThreshold,
        )
        .sort((a, b) => (b.cycleTimeMs ?? 0) - (a.cycleTimeMs ?? 0));

      const patterns: RetrospectivePattern[] = [];

      if (retryChurnCount > 0) {
        patterns.push({
          id: "retry_churn",
          title: "Retry churn",
          severity: retryChurnCount >= Math.max(2, Math.ceil(tasks.length * 0.4)) ? "high" : "medium",
          count: retryChurnCount,
          recommendation:
            "Front-load CI and review checks inside the agent loop so failures are detected before handoff.",
        });
      }

      if (reopenedCount > 0) {
        patterns.push({
          id: "reopened_work",
          title: "Reopened work",
          severity: reopenedCount >= Math.max(2, Math.ceil(tasks.length * 0.25)) ? "high" : "medium",
          count: reopenedCount,
          recommendation:
            "Tighten acceptance contracts and verification gates before marking tasks complete.",
        });
      }

      if (slowTasks.length > 0) {
        patterns.push({
          id: "long_cycle_time",
          title: "Long cycle time",
          severity: slowTasks.length >= Math.max(2, Math.ceil(tasks.length * 0.3)) ? "high" : "low",
          count: slowTasks.length,
          recommendation:
            "Split oversized tasks into smaller scopes and checkpoint progress with mid-cycle reviews.",
        });
      }

      if (incompleteCount > 0) {
        patterns.push({
          id: "incomplete_work",
          title: "Incomplete work",
          severity: incompleteCount >= Math.max(2, Math.ceil(tasks.length * 0.3)) ? "high" : "medium",
          count: incompleteCount,
          recommendation:
            "Escalate stalled sessions sooner and require explicit unblock plans when no transition occurs.",
        });
      }

      const highlights = [
        `Completed tasks: ${summary.overall.completedTasks}/${summary.overall.taskCount}`,
        `First-pass success rate: ${(summary.overall.firstPassRate * 100).toFixed(1)}%`,
        `Average retries per task: ${summary.overall.averageRetries.toFixed(2)}`,
      ];

      if (summary.overall.averageCycleTimeMs !== null) {
        highlights.push(
          `Average cycle time: ${(summary.overall.averageCycleTimeMs / 3_600_000).toFixed(2)}h`,
        );
      }

      const recommendations = patterns
        .sort((a, b) => b.count - a.count)
        .map((pattern) => pattern.recommendation);

      const topSlowTasks = slowTasks.slice(0, 5).map((task) => ({
        projectId: task.projectId,
        planId: task.planId,
        taskId: task.taskId,
        cycleTimeMs: task.cycleTimeMs ?? 0,
      }));

      return {
        generatedAt: now().toISOString(),
        filters: query ?? {},
        overview: summary.overall,
        highlights,
        failurePatterns: patterns.sort((a, b) => b.count - a.count),
        recommendations,
        topSlowTasks,
      };
    },
  };
}
