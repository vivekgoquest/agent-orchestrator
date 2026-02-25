import type { PlanTaskNode, StructuredWorkPlan } from "./types.js";
import { validateWorkPlan } from "./work-plan.js";

export type TaskId = string;
export type TaskState = "blocked" | "ready" | "running" | "complete";

export interface TaskGraphNode {
  id: TaskId;
  task: PlanTaskNode;
  dependencies: TaskId[];
  dependents: TaskId[];
  state: TaskState;
}

export interface TaskGraph {
  planGoal: string;
  nodes: Record<TaskId, TaskGraphNode>;
  order: TaskId[];
}

export interface TaskGraphSnapshot {
  states: Record<TaskId, TaskState>;
}

export class TaskGraphCycleError extends Error {
  constructor(public readonly cyclePath: TaskId[]) {
    super(`Task graph contains a cycle: ${cyclePath.join(" -> ")}`);
    this.name = "TaskGraphCycleError";
  }
}

export class TaskTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskTransitionError";
  }
}

export interface TaskTransitionResult {
  taskId: TaskId;
  from: TaskState;
  to: TaskState;
  unlockedTaskIds: TaskId[];
}

/**
 * Build a normalized DAG model from a validated WorkPlan.
 * Throws TaskGraphCycleError with cycle path details if the plan is cyclic.
 */
export function buildTaskGraph(rawPlan: StructuredWorkPlan | unknown): TaskGraph {
  const plan = validateWorkPlan(rawPlan);
  const flattenedTasks = flattenTasks(plan.tasks);

  const nodes: Record<TaskId, TaskGraphNode> = {};
  const order: TaskId[] = [];

  for (const task of flattenedTasks) {
    nodes[task.id] = {
      id: task.id,
      task: cloneTask(task),
      dependencies: [...task.dependencies],
      dependents: [],
      state: "blocked",
    };
    order.push(task.id);
  }

  for (const taskId of order) {
    const task = mustGetNodeFromRecord(nodes, taskId);
    for (const dependency of task.dependencies) {
      mustGetNodeFromRecord(nodes, dependency).dependents.push(taskId);
    }
  }

  const graph: TaskGraph = {
    planGoal: plan.goal,
    nodes,
    order,
  };

  const cyclePath = findCyclePath(graph);
  if (cyclePath) {
    throw new TaskGraphCycleError(cyclePath);
  }

  syncBlockedAndReadyStates(graph);
  return graph;
}

/** Find a cycle and return its path, ending where it started. */
export function findCyclePath(graph: TaskGraph): TaskId[] | null {
  const visiting = new Set<TaskId>();
  const visited = new Set<TaskId>();
  const stack: TaskId[] = [];

  const visit = (taskId: TaskId): TaskId[] | null => {
    if (visiting.has(taskId)) {
      const cycleStart = stack.indexOf(taskId);
      return [...stack.slice(cycleStart), taskId];
    }

    if (visited.has(taskId)) {
      return null;
    }

    visiting.add(taskId);
    stack.push(taskId);

    for (const dependency of mustGetNode(graph, taskId).dependencies) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }

    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  };

  for (const taskId of graph.order) {
    const cycle = visit(taskId);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

/** Return all tasks currently eligible to execute. */
export function getReadyTaskIds(graph: TaskGraph): TaskId[] {
  syncBlockedAndReadyStates(graph);
  return graph.order.filter((taskId) => mustGetNode(graph, taskId).state === "ready");
}

/**
 * Transition a task state in the only supported order:
 * blocked -> ready -> running -> complete.
 */
export function transitionTaskState(
  graph: TaskGraph,
  taskId: TaskId,
  nextState: TaskState,
): TaskTransitionResult {
  const node = mustGetNode(graph, taskId);
  syncBlockedAndReadyStates(graph);

  const previous = node.state;
  if (previous === nextState) {
    return {
      taskId,
      from: previous,
      to: nextState,
      unlockedTaskIds: [],
    };
  }

  validateTransition(graph, node, nextState);
  node.state = nextState;
  const unlockedTaskIds = nextState === "complete" ? syncBlockedAndReadyStates(graph) : [];

  return {
    taskId,
    from: previous,
    to: nextState,
    unlockedTaskIds,
  };
}

/**
 * Ensure blocked and ready states match dependency completion.
 * Returns ids that were unlocked during this sync pass.
 */
export function syncBlockedAndReadyStates(graph: TaskGraph): TaskId[] {
  const unlockedTaskIds: TaskId[] = [];

  for (const taskId of graph.order) {
    const node = mustGetNode(graph, taskId);
    if (node.state === "running" || node.state === "complete") {
      continue;
    }

    const depsComplete = node.dependencies.every(
      (dependencyId) => mustGetNode(graph, dependencyId).state === "complete",
    );

    if (depsComplete) {
      if (node.state !== "ready") {
        node.state = "ready";
        unlockedTaskIds.push(taskId);
      }
      continue;
    }

    node.state = "blocked";
  }

  return unlockedTaskIds;
}

/** Capture task states so they can be persisted and restored later. */
export function snapshotTaskGraph(graph: TaskGraph): TaskGraphSnapshot {
  const states: Record<TaskId, TaskState> = {};
  for (const taskId of graph.order) {
    states[taskId] = mustGetNode(graph, taskId).state;
  }
  return { states };
}

/** Apply a persisted snapshot to an existing graph and re-sync ready/blocked states. */
export function applyTaskGraphSnapshot(graph: TaskGraph, snapshot: TaskGraphSnapshot): void {
  for (const [taskId, state] of Object.entries(snapshot.states)) {
    const node = mustGetNode(graph, taskId);
    if (!isTaskState(state)) {
      throw new TaskTransitionError(`Invalid persisted task state for "${taskId}": "${state}"`);
    }
    node.state = state;
  }

  validatePersistedStates(graph);
  syncBlockedAndReadyStates(graph);
}

function validateTransition(graph: TaskGraph, node: TaskGraphNode, nextState: TaskState): void {
  const state = node.state;

  if (state === "complete") {
    throw new TaskTransitionError(`Task "${node.id}" is complete and cannot transition to "${nextState}"`);
  }

  if (state === "blocked") {
    if (nextState !== "ready") {
      throw new TaskTransitionError(
        `Task "${node.id}" must transition from "blocked" to "ready" before "${nextState}"`,
      );
    }

    const incompleteDependencies = node.dependencies.filter(
      (dependencyId) => mustGetNode(graph, dependencyId).state !== "complete",
    );

    if (incompleteDependencies.length > 0) {
      throw new TaskTransitionError(
        `Task "${node.id}" cannot become ready; incomplete dependencies: ${incompleteDependencies.join(", ")}`,
      );
    }
    return;
  }

  if (state === "ready") {
    if (nextState !== "running") {
      throw new TaskTransitionError(
        `Task "${node.id}" must transition from "ready" to "running", not "${nextState}"`,
      );
    }
    return;
  }

  if (state === "running") {
    if (nextState !== "complete") {
      throw new TaskTransitionError(
        `Task "${node.id}" must transition from "running" to "complete", not "${nextState}"`,
      );
    }
    return;
  }

  throw new TaskTransitionError(
    `Unsupported transition requested for task "${node.id}": "${state}" -> "${nextState}"`,
  );
}

function mustGetNode(graph: TaskGraph, taskId: TaskId): TaskGraphNode {
  const node = graph.nodes[taskId];
  if (!node) {
    throw new TaskTransitionError(`Task "${taskId}" does not exist in graph "${graph.planGoal}"`);
  }
  return node;
}

function mustGetNodeFromRecord(nodes: Record<TaskId, TaskGraphNode>, taskId: TaskId): TaskGraphNode {
  const node = nodes[taskId];
  if (!node) {
    throw new TaskTransitionError(`Task "${taskId}" referenced in dependency map does not exist`);
  }
  return node;
}

function isTaskState(value: string): value is TaskState {
  return value === "blocked" || value === "ready" || value === "running" || value === "complete";
}

function validatePersistedStates(graph: TaskGraph): void {
  for (const taskId of graph.order) {
    const node = mustGetNode(graph, taskId);
    if (node.state !== "running" && node.state !== "complete") {
      continue;
    }

    const incompleteDependencies = node.dependencies.filter(
      (dependencyId) => mustGetNode(graph, dependencyId).state !== "complete",
    );

    if (incompleteDependencies.length > 0) {
      throw new TaskTransitionError(
        `Task "${taskId}" is "${node.state}" but has incomplete dependencies: ${incompleteDependencies.join(
          ", ",
        )}`,
      );
    }
  }
}

function flattenTasks(tasks: PlanTaskNode[]): PlanTaskNode[] {
  const flattened: PlanTaskNode[] = [];
  for (const task of tasks) {
    flattened.push(task);
    if (task.subtasks) {
      flattened.push(...flattenTasks(task.subtasks));
    }
  }
  return flattened;
}

function cloneTask(task: PlanTaskNode): PlanTaskNode {
  return {
    ...task,
    dependencies: [...task.dependencies],
    risks: [...task.risks],
    acceptanceChecks: [...task.acceptanceChecks],
    subtasks: task.subtasks ? task.subtasks.map((subtask) => cloneTask(subtask)) : undefined,
  };
}
