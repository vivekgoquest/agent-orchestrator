import { describe, expect, it } from "vitest";
import { createScheduler, type TaskGraph } from "../scheduler.js";

function graphFrom(nodes: TaskGraph["nodes"]): TaskGraph {
  return { nodes };
}

describe("createScheduler", () => {
  it("returns only unblocked tasks whose dependencies are complete", () => {
    const scheduler = createScheduler({ concurrencyCap: 10 });
    const graph = graphFrom({
      prep: { id: "prep", state: "complete" },
      blockedTask: {
        id: "blockedTask",
        state: "blocked",
        dependencies: ["prep"],
        priority: 100,
      },
      readyTask: {
        id: "readyTask",
        state: "ready",
        dependencies: ["prep"],
        priority: 10,
      },
      pendingButUnlocked: {
        id: "pendingButUnlocked",
        state: "pending",
        dependencies: ["prep"],
        priority: 5,
      },
      waitingOnDependency: {
        id: "waitingOnDependency",
        state: "pending",
        dependencies: ["blockedTask"],
        priority: 1000,
      },
    });

    const result = scheduler.getReadyQueue(graph);
    expect(result.readyQueue.map((node) => node.id)).toEqual(["readyTask", "pendingButUnlocked"]);
  });

  it("honors concurrency cap when selecting ready queue", () => {
    const scheduler = createScheduler({ concurrencyCap: 3 });
    const graph = graphFrom({
      runningA: { id: "runningA", state: "running" },
      runningB: { id: "runningB", state: "running" },
      highPriority: { id: "highPriority", state: "ready", priority: 100 },
      lowPriority: { id: "lowPriority", state: "ready", priority: 1 },
    });

    const result = scheduler.getReadyQueue(graph);
    expect(result.runningCount).toBe(2);
    expect(result.availableSlots).toBe(1);
    expect(result.readyQueue.map((node) => node.id)).toEqual(["highPriority"]);
  });

  it("is deterministic for equal-priority tasks", () => {
    const scheduler = createScheduler({ concurrencyCap: 10 });
    const graph = graphFrom({
      delta: { id: "delta", state: "ready", priority: 10, runCount: 1, readySince: 5 },
      alpha: { id: "alpha", state: "ready", priority: 10, runCount: 1, readySince: 5 },
      charlie: { id: "charlie", state: "ready", priority: 10, runCount: 1, readySince: 5 },
      bravo: { id: "bravo", state: "ready", priority: 10, runCount: 1, readySince: 5 },
    });

    const runA = scheduler.getReadyQueue(graph).readyQueue.map((node) => node.id);
    const runB = scheduler.getReadyQueue(graph).readyQueue.map((node) => node.id);
    expect(runA).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(runB).toEqual(runA);
  });

  it("applies fairness hints after priority", () => {
    const scheduler = createScheduler({ concurrencyCap: 10 });
    const graph = graphFrom({
      highestPriority: { id: "highestPriority", state: "ready", priority: 100, runCount: 999 },
      olderReady: { id: "olderReady", state: "ready", priority: 5, runCount: 1, readySince: 1 },
      fewerRuns: { id: "fewerRuns", state: "ready", priority: 5, runCount: 0, readySince: 999 },
    });

    const result = scheduler.getReadyQueue(graph);
    expect(result.readyQueue.map((node) => node.id)).toEqual([
      "highestPriority",
      "fewerRuns",
      "olderReady",
    ]);
  });

  it("supports configurable aging policy to reduce starvation", () => {
    const scheduler = createScheduler({
      concurrencyCap: 10,
      priorityPolicy: "aging",
      agingWindowMs: 60_000,
      maxAgingBoost: 5,
      now: () => 600_000,
    });
    const graph = graphFrom({
      freshHigh: { id: "freshHigh", state: "ready", priority: 10, readySince: 590_000 },
      staleMedium: { id: "staleMedium", state: "ready", priority: 7, readySince: 0 },
      staleLow: { id: "staleLow", state: "ready", priority: 2, readySince: 0 },
    });

    const result = scheduler.getReadyQueue(graph);
    expect(result.readyQueue.map((node) => node.id)).toEqual(["staleMedium", "freshHigh", "staleLow"]);
  });

  it("supports pause/resume for blocked tasks", () => {
    const scheduler = createScheduler({ concurrencyCap: 10 });
    const initial = graphFrom({
      dep: { id: "dep", state: "complete" },
      task: { id: "task", state: "blocked", dependencies: ["dep"] },
    });

    const pausedGraph = scheduler.pauseTask(initial, "task");
    expect(pausedGraph.nodes["task"]?.state).toBe("paused");
    expect(scheduler.getReadyQueue(pausedGraph).readyQueue).toEqual([]);

    const resumedGraph = scheduler.resumeTask(pausedGraph, "task");
    expect(resumedGraph.nodes["task"]?.state).toBe("ready");
    expect(scheduler.getReadyQueue(resumedGraph).readyQueue.map((node) => node.id)).toEqual(["task"]);
  });

  it("resumes paused tasks back to blocked when dependencies are blocked", () => {
    const scheduler = createScheduler({ concurrencyCap: 10 });
    const initial = graphFrom({
      dep: { id: "dep", state: "blocked" },
      task: { id: "task", state: "blocked", dependencies: ["dep"] },
    });

    const pausedGraph = scheduler.pauseTask(initial, "task");
    expect(pausedGraph.nodes["task"]?.state).toBe("paused");

    const resumedGraph = scheduler.resumeTask(pausedGraph, "task");
    expect(resumedGraph.nodes["task"]?.state).toBe("blocked");
    expect(scheduler.getReadyQueue(resumedGraph).readyQueue).toEqual([]);
  });

  it("validates aging config fields", () => {
    expect(() => createScheduler({ concurrencyCap: 1, priorityPolicy: "aging", agingWindowMs: 0 })).toThrow(
      "Scheduler config error: agingWindowMs must be an integer > 0 when provided",
    );
    expect(() => createScheduler({ concurrencyCap: 1, priorityPolicy: "aging", maxAgingBoost: -1 })).toThrow(
      "Scheduler config error: maxAgingBoost must be an integer >= 0 when provided",
    );
  });

  it("throws when dependency references a missing node", () => {
    const scheduler = createScheduler({ concurrencyCap: 1 });
    const graph = graphFrom({
      task: { id: "task", state: "ready", dependencies: ["missing"] },
    });

    expect(() => scheduler.getReadyQueue(graph)).toThrow(
      'Task "task" depends on missing node "missing"',
    );
  });
});
