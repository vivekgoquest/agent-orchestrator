import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import {
  getSessionsDir,
  writePlanBlob,
  type Session,
  type SessionManager,
} from "@composio/ao-core";
import { registerBatchSpawn } from "../../src/commands/spawn.js";

const { mockExec, mockSessionManager } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockSessionManager: {
    list: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    send: vi.fn(),
  },
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: vi.fn(),
  exec: mockExec,
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: vi.fn().mockResolvedValue([]),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

describe("batch-spawn scheduler integration", () => {
  let tmpDir: string;
  let repoPath: string;
  let configPath: string;
  let previousConfigPath: string | undefined;
  let program: Command;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  const planSessionId = "orch-plan-1";

  function writeConfig(): void {
    const yaml = [
      "port: 3000",
      "defaults:",
      "  runtime: process",
      "  agent: opencode",
      "  workspace: clone",
      "  notifiers: []",
      "projects:",
      "  my-app:",
      "    name: My App",
      "    repo: org/my-app",
      `    path: ${repoPath}`,
      "    defaultBranch: main",
      "    sessionPrefix: app",
      "notificationRouting: {}",
      "notifiers: {}",
      "reactions: {}",
    ].join("\n");
    writeFileSync(configPath, yaml + "\n");
  }

  function writeValidatedPlan(version: number, tasks: unknown[]): void {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    writePlanBlob(sessionsDir, planSessionId, {
      planId: "workplan",
      planVersion: version,
      planStatus: "validated",
      blob: { tasks },
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-spawn-scheduler-int-"));
    repoPath = join(tmpDir, "repo");
    configPath = join(tmpDir, "agent-orchestrator.yaml");

    mkdirSync(repoPath, { recursive: true });
    writeConfig();

    previousConfigPath = process.env["AO_CONFIG_PATH"];
    process.env["AO_CONFIG_PATH"] = configPath;

    program = new Command();
    program.exitOverride();
    registerBatchSpawn(program);

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    mockSessionManager.list.mockReset();
    mockSessionManager.spawn.mockReset();
    mockExec.mockReset();
  });

  afterEach(() => {
    if (previousConfigPath === undefined) {
      delete process.env["AO_CONFIG_PATH"];
    } else {
      process.env["AO_CONFIG_PATH"] = previousConfigPath;
    }

    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("unlocks dependent tasks across validated plan versions", async () => {
    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.spawn.mockResolvedValue({
      id: "app-3",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/INT-302",
      issueId: "INT-302",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-3", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    } satisfies Session);

    writeValidatedPlan(1, [
      { id: "task-1", issueId: "INT-301", state: "pending" },
      { id: "task-2", issueId: "INT-302", state: "pending", dependencies: ["task-1"] },
    ]);

    await program.parseAsync([
      "node",
      "test",
      "batch-spawn",
      "my-app",
      "task-2",
      "--plan-session",
      planSessionId,
    ]);

    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    let output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Scheduling rationale:");
    expect(output).toContain("Skip task-2 — blocked by incomplete dependencies: task-1");

    consoleSpy.mockClear();
    writeValidatedPlan(2, [
      { id: "task-1", issueId: "INT-301", state: "complete" },
      { id: "task-2", issueId: "INT-302", state: "pending", dependencies: ["task-1"] },
    ]);

    await program.parseAsync([
      "node",
      "test",
      "batch-spawn",
      "my-app",
      "task-2",
      "--plan-session",
      planSessionId,
    ]);

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "INT-302",
      agent: undefined,
    });

    output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Scheduling rationale:");
    expect(output).toContain("Ready queue: task-2");
  });
});
