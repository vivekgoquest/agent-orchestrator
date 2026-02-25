import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createOutcomeMetricsStore } from "../outcome-metrics.js";
import { getProjectBaseDir } from "../paths.js";
import type { OrchestratorConfig } from "../types.js";

let tmpRoot: string;
let config: OrchestratorConfig;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `ao-test-outcomes-${randomUUID()}`);
  mkdirSync(tmpRoot, { recursive: true });
  writeFileSync(join(tmpRoot, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

  config = {
    configPath: join(tmpRoot, "agent-orchestrator.yaml"),
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "acme/my-app",
        path: join(tmpRoot, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  };
});

afterEach(() => {
  const projectBaseDir = getProjectBaseDir(config.configPath, config.projects["my-app"].path);
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createOutcomeMetricsStore", () => {
  it("rolls up retries, reopen count, and cycle time for a task", () => {
    const store = createOutcomeMetricsStore(config);

    store.recordTransition({
      sessionId: "app-1",
      projectId: "my-app",
      taskId: "task-1",
      planId: "plan-a",
      issueId: "ISSUE-1",
      fromStatus: "spawning",
      toStatus: "working",
      timestamp: "2026-02-25T10:00:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-1",
      projectId: "my-app",
      taskId: "task-1",
      planId: "plan-a",
      issueId: "ISSUE-1",
      fromStatus: "working",
      toStatus: "ci_failed",
      timestamp: "2026-02-25T10:10:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-1",
      projectId: "my-app",
      taskId: "task-1",
      planId: "plan-a",
      issueId: "ISSUE-1",
      fromStatus: "ci_failed",
      toStatus: "working",
      timestamp: "2026-02-25T10:20:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-1",
      projectId: "my-app",
      taskId: "task-1",
      planId: "plan-a",
      issueId: "ISSUE-1",
      fromStatus: "working",
      toStatus: "merged",
      timestamp: "2026-02-25T10:30:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-1",
      projectId: "my-app",
      taskId: "task-1",
      planId: "plan-a",
      issueId: "ISSUE-1",
      fromStatus: "merged",
      toStatus: "working",
      timestamp: "2026-02-25T10:40:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-1",
      projectId: "my-app",
      taskId: "task-1",
      planId: "plan-a",
      issueId: "ISSUE-1",
      fromStatus: "working",
      toStatus: "merged",
      timestamp: "2026-02-25T10:50:00.000Z",
    });

    const summary = store.getSummary();
    expect(summary.transitionCount).toBe(6);
    expect(summary.tasks).toHaveLength(1);

    const task = summary.tasks[0];
    expect(task.retries).toBe(1);
    expect(task.reopenCount).toBe(1);
    expect(task.failureSignals).toBe(1);
    expect(task.firstPassSuccess).toBe(false);
    expect(task.startedAt).toBe("2026-02-25T10:00:00.000Z");
    expect(task.completedAt).toBe("2026-02-25T10:50:00.000Z");
    expect(task.cycleTimeMs).toBe(3_000_000);
  });

  it("computes plan rollups across tasks", () => {
    const store = createOutcomeMetricsStore(config);

    // Task 1: first-pass success
    store.recordTransition({
      sessionId: "app-2",
      projectId: "my-app",
      taskId: "task-1",
      planId: "plan-a",
      fromStatus: "spawning",
      toStatus: "working",
      timestamp: "2026-02-25T09:00:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-2",
      projectId: "my-app",
      taskId: "task-1",
      planId: "plan-a",
      fromStatus: "working",
      toStatus: "merged",
      timestamp: "2026-02-25T09:30:00.000Z",
    });

    // Task 2: one retry
    store.recordTransition({
      sessionId: "app-3",
      projectId: "my-app",
      taskId: "task-2",
      planId: "plan-a",
      fromStatus: "spawning",
      toStatus: "working",
      timestamp: "2026-02-25T10:00:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-3",
      projectId: "my-app",
      taskId: "task-2",
      planId: "plan-a",
      fromStatus: "working",
      toStatus: "ci_failed",
      timestamp: "2026-02-25T10:10:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-3",
      projectId: "my-app",
      taskId: "task-2",
      planId: "plan-a",
      fromStatus: "ci_failed",
      toStatus: "working",
      timestamp: "2026-02-25T10:20:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-3",
      projectId: "my-app",
      taskId: "task-2",
      planId: "plan-a",
      fromStatus: "working",
      toStatus: "merged",
      timestamp: "2026-02-25T10:40:00.000Z",
    });

    const summary = store.getSummary({ planId: "plan-a" });
    expect(summary.tasks).toHaveLength(2);
    expect(summary.plans).toHaveLength(1);

    const plan = summary.plans[0];
    expect(plan.taskCount).toBe(2);
    expect(plan.completedTasks).toBe(2);
    expect(plan.firstPassRate).toBe(0.5);
    expect(plan.averageRetries).toBe(0.5);
    expect(plan.averageCycleTimeMs).toBe(2_100_000);
  });

  it("generates a retrospective report with failure patterns and recommendations", () => {
    const store = createOutcomeMetricsStore(config);

    // Incomplete task
    store.recordTransition({
      sessionId: "app-4",
      projectId: "my-app",
      taskId: "task-incomplete",
      planId: "plan-r",
      fromStatus: "spawning",
      toStatus: "working",
      timestamp: "2026-02-25T08:00:00.000Z",
    });

    // Retry + reopen task
    store.recordTransition({
      sessionId: "app-5",
      projectId: "my-app",
      taskId: "task-retry",
      planId: "plan-r",
      fromStatus: "spawning",
      toStatus: "working",
      timestamp: "2026-02-25T08:00:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-5",
      projectId: "my-app",
      taskId: "task-retry",
      planId: "plan-r",
      fromStatus: "working",
      toStatus: "changes_requested",
      timestamp: "2026-02-25T09:00:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-5",
      projectId: "my-app",
      taskId: "task-retry",
      planId: "plan-r",
      fromStatus: "changes_requested",
      toStatus: "working",
      timestamp: "2026-02-25T10:00:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-5",
      projectId: "my-app",
      taskId: "task-retry",
      planId: "plan-r",
      fromStatus: "working",
      toStatus: "merged",
      timestamp: "2026-02-25T11:00:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-5",
      projectId: "my-app",
      taskId: "task-retry",
      planId: "plan-r",
      fromStatus: "merged",
      toStatus: "working",
      timestamp: "2026-02-25T12:00:00.000Z",
    });
    store.recordTransition({
      sessionId: "app-5",
      projectId: "my-app",
      taskId: "task-retry",
      planId: "plan-r",
      fromStatus: "working",
      toStatus: "merged",
      timestamp: "2026-02-25T13:00:00.000Z",
    });

    const report = store.generateRetrospective({ planId: "plan-r" });
    const patternIds = report.failurePatterns.map((pattern) => pattern.id);

    expect(report.overview.taskCount).toBe(2);
    expect(report.highlights.length).toBeGreaterThan(0);
    expect(patternIds).toContain("retry_churn");
    expect(patternIds).toContain("reopened_work");
    expect(patternIds).toContain("incomplete_work");
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});
