import { describe, expect, it } from "vitest";
import {
  applyTaskGraphSnapshot,
  buildTaskGraph,
  snapshotTaskGraph,
  TaskGraphCycleError,
  transitionTaskState,
} from "../task-graph.js";
import type { WorkPlan } from "../types.js";

function makePlan(tasks: WorkPlan["tasks"]): WorkPlan {
  return {
    schemaVersion: "1.0",
    goal: "Task graph tests",
    tasks,
    acceptance: {
      definitionOfDone: "All tasks complete",
      checks: [
        {
          id: "ac-1",
          description: "Graph behavior validated",
          verification: "vitest",
          required: true,
        },
      ],
    },
  };
}

function makeTask(id: string, dependencies: string[] = []): WorkPlan["tasks"][number] {
  return {
    id,
    title: id,
    description: `Task ${id}`,
    priority: "medium",
    dependencies,
    risks: [],
    acceptanceChecks: ["ac-1"],
  };
}

describe("TaskGraph", () => {
  it("rejects cyclic plans and includes cycle path details", () => {
    expect(() =>
      buildTaskGraph(
        makePlan([
          makeTask("task-a", ["task-c"]),
          makeTask("task-b", ["task-a"]),
          makeTask("task-c", ["task-b"]),
        ]),
      ),
    ).toThrow(TaskGraphCycleError);

    expect(() =>
      buildTaskGraph(
        makePlan([
          makeTask("task-a", ["task-c"]),
          makeTask("task-b", ["task-a"]),
          makeTask("task-c", ["task-b"]),
        ]),
      ),
    ).toThrow(/task-a -> task-c -> task-b -> task-a|task-b -> task-a -> task-c -> task-b/);
  });

  it("initializes dependency-free nodes as ready and dependent nodes as blocked", () => {
    const graph = buildTaskGraph(makePlan([makeTask("task-a"), makeTask("task-b", ["task-a"])]));

    expect(graph.nodes["task-a"]!.state).toBe("ready");
    expect(graph.nodes["task-b"]!.state).toBe("blocked");
  });

  it("unlocks fan-out dependents when parent completes", () => {
    const graph = buildTaskGraph(
      makePlan([makeTask("task-a"), makeTask("task-b", ["task-a"]), makeTask("task-c", ["task-a"])]),
    );

    transitionTaskState(graph, "task-a", "running");
    const completion = transitionTaskState(graph, "task-a", "complete");

    expect(completion.unlockedTaskIds.sort()).toEqual(["task-b", "task-c"]);
    expect(graph.nodes["task-b"]!.state).toBe("ready");
    expect(graph.nodes["task-c"]!.state).toBe("ready");
  });

  it("handles fan-in dependencies by unlocking only after all predecessors complete", () => {
    const graph = buildTaskGraph(
      makePlan([makeTask("task-a"), makeTask("task-b"), makeTask("task-c", ["task-a", "task-b"])]),
    );

    transitionTaskState(graph, "task-a", "running");
    const completeA = transitionTaskState(graph, "task-a", "complete");
    expect(completeA.unlockedTaskIds).toEqual([]);
    expect(graph.nodes["task-c"]!.state).toBe("blocked");

    transitionTaskState(graph, "task-b", "running");
    const completeB = transitionTaskState(graph, "task-b", "complete");
    expect(completeB.unlockedTaskIds).toEqual(["task-c"]);
    expect(graph.nodes["task-c"]!.state).toBe("ready");
  });

  it("enforces blocked -> ready -> running -> complete transition order", () => {
    const graph = buildTaskGraph(makePlan([makeTask("task-a"), makeTask("task-b", ["task-a"])]));

    expect(() => transitionTaskState(graph, "task-b", "running")).toThrow(/must transition from "blocked"/);

    transitionTaskState(graph, "task-a", "running");
    transitionTaskState(graph, "task-a", "complete");

    expect(graph.nodes["task-b"]!.state).toBe("ready");
    transitionTaskState(graph, "task-b", "running");
    transitionTaskState(graph, "task-b", "complete");
    expect(graph.nodes["task-b"]!.state).toBe("complete");

    expect(() => transitionTaskState(graph, "task-b", "ready")).toThrow(/is complete and cannot transition/);
  });

  it("round-trips persisted task states", () => {
    const plan = makePlan([makeTask("task-a"), makeTask("task-b", ["task-a"])]);

    const graph = buildTaskGraph(plan);
    transitionTaskState(graph, "task-a", "running");
    transitionTaskState(graph, "task-a", "complete");
    transitionTaskState(graph, "task-b", "running");
    const snapshot = snapshotTaskGraph(graph);

    const restored = buildTaskGraph(plan);
    applyTaskGraphSnapshot(restored, snapshot);

    expect(restored.nodes["task-a"]!.state).toBe("complete");
    expect(restored.nodes["task-b"]!.state).toBe("running");
  });
});
