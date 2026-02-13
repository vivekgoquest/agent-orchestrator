import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@agent-orchestrator/core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const { mockExecFileAsync, mockReaddir, mockReadFile, mockStat, mockHomedir } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
  mockHomedir: vi.fn(() => "/mock/home"),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test-project",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number): RuntimeHandle {
  return { id: "proc-1", runtimeName: "process", data: pid !== undefined ? { pid } : {} };
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

function mockTmuxWithProcess(processName = "claude", tty = "/dev/ttys001", pid = 12345) {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: `${tty}\n`, stderr: "" });
    }
    if (cmd === "ps") {
      const ttyShort = tty.replace(/^\/dev\//, "");
      // Matches `ps -eo pid,tty,args` output format
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n  ${pid} ${ttyShort}  ${processName}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
  });
}

function mockTmuxWithActivity(terminalOutput: string, processName = "claude") {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
    }
    if (cmd === "ps") {
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n  123 ttys001  ${processName}\n`,
        stderr: "",
      });
    }
    if (cmd === "tmux" && args[0] === "capture-pane") {
      return Promise.resolve({ stdout: terminalOutput, stderr: "" });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
  });
}

function mockJsonlFiles(
  jsonlContent: string,
  files = ["session-abc123.jsonl"],
  mtime = new Date(1700000000000),
) {
  mockReaddir.mockResolvedValue(files);
  mockStat.mockResolvedValue({ mtimeMs: mtime.getTime(), mtime });
  mockReadFile.mockResolvedValue(jsonlContent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  mockHomedir.mockReturnValue("/mock/home");
});

describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "claude-code",
      slot: "agent",
      description: "Agent plugin: Claude Code CLI",
      version: "0.1.0",
    });
  });

  it("create() returns an agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("claude-code");
    expect(agent.processName).toBe("claude");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

// =========================================================================
// getLaunchCommand
// =========================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command without shell syntax", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("claude");
    // Must not contain shell operators (execFile-safe)
    expect(cmd).not.toContain("&&");
    expect(cmd).not.toContain("unset");
  });

  it("includes --dangerously-skip-permissions when permissions=skip", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("shell-escapes model argument", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-opus-4-6" }));
    expect(cmd).toContain("--model 'claude-opus-4-6'");
  });

  it("shell-escapes prompt argument", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).toContain("-p 'Fix the bug'");
  });

  it("escapes dangerous characters in prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "$(rm -rf /); `evil`; $HOME" }));
    // Single-quoted strings prevent shell expansion
    expect(cmd).toContain("-p '$(rm -rf /); `evil`; $HOME'");
  });

  it("escapes single quotes in prompt using POSIX method", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's a test" }));
    expect(cmd).toContain("-p 'it'\\''s a test'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip", model: "opus", prompt: "Hello" }),
    );
    expect(cmd).toBe("claude --dangerously-skip-permissions --model 'opus' -p 'Hello'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("-p");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets CLAUDECODE to empty string (replaces unset in command)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["CLAUDECODE"]).toBe("");
  });

  it("sets AO_SESSION_ID and AO_PROJECT_ID", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_PROJECT_ID"]).toBe("my-project");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-100" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-100");
  });

  it("does not set AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when claude is found on tmux pane TTY", async () => {
    mockTmuxWithProcess("claude");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when no claude on tmux pane TTY", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys002\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  999 ttys002  bash\n",
          stderr: "",
        });
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when tmux list-panes returns empty", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process runtime with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(999))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(999, 0);
    killSpy.mockRestore();
  });

  it("returns false for process runtime with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(999))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false for unknown runtime without PID (no pgrep fallback)", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
    // Must NOT call pgrep — could match wrong session
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns false when tmux command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("fail"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("finds claude on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  claude -p test\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("does not match similar process names like claude-code", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  /usr/bin/claude-code\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });
});

// =========================================================================
// detectActivity
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns exited when no runtime handle", async () => {
    expect(await agent.detectActivity(makeSession())).toBe("exited");
  });

  it("returns exited when process is not found", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      if (cmd === "ps") return Promise.resolve({ stdout: "  PID TT ARGS\n", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    expect(await agent.detectActivity(session)).toBe("exited");
  });

  describe("active patterns (stable indicators)", () => {
    const activeStrings = [
      "Thinking about your request...",
      "Pondering the architecture",
      "Analyzing the codebase",
      "\u23FA Recording output",
      "press esc to interrupt the agent",
    ];

    for (const output of activeStrings) {
      it(`detects "${output.trim().substring(0, 40)}" as active`, async () => {
        mockTmuxWithActivity(output);
        const session = makeSession({ runtimeHandle: makeTmuxHandle() });
        expect(await agent.detectActivity(session)).toBe("active");
      });
    }
  });

  describe("idle patterns", () => {
    it("detects bare prompt as idle", async () => {
      mockTmuxWithActivity("some previous output\n❯ \n");
      const session = makeSession({ runtimeHandle: makeTmuxHandle() });
      expect(await agent.detectActivity(session)).toBe("idle");
    });

    it("detects bare > prompt as idle", async () => {
      mockTmuxWithActivity("output\n> \n");
      const session = makeSession({ runtimeHandle: makeTmuxHandle() });
      expect(await agent.detectActivity(session)).toBe("idle");
    });
  });

  describe("waiting_input patterns", () => {
    const inputStrings = [
      "Do you want to continue? [y/N]",
      "Apply changes? [Y/n]",
      "Continue?",
      "Proceed?",
      "Do you want to allow this?",
      "Allow access to file?",
      "Approve this action?",
      "Permission required to write",
    ];

    for (const output of inputStrings) {
      it(`detects "${output.substring(0, 40)}" as waiting_input`, async () => {
        mockTmuxWithActivity(output);
        const session = makeSession({ runtimeHandle: makeTmuxHandle() });
        expect(await agent.detectActivity(session)).toBe("waiting_input");
      });
    }
  });

  describe("blocked patterns (specific error framing)", () => {
    const blockedStrings = [
      "Error: module not found",
      "\u2717 Build failed",
      "ENOENT: no such file or directory",
      "EACCES: permission denied",
      "quota exceeded for this billing period",
      "rate limit exceeded",
      "APIError: 429 Too Many Requests",
      "NetworkError: connection refused",
    ];

    for (const output of blockedStrings) {
      it(`detects "${output.substring(0, 40)}" as blocked`, async () => {
        mockTmuxWithActivity(output);
        const session = makeSession({ runtimeHandle: makeTmuxHandle() });
        expect(await agent.detectActivity(session)).toBe("blocked");
      });
    }

    it("does NOT trigger blocked on casual mentions of 'error'", async () => {
      // "Fixed the error" should not match — broad "error" pattern was removed
      mockTmuxWithActivity("Fixed the error in auth.ts");
      const session = makeSession({ runtimeHandle: makeTmuxHandle() });
      expect(await agent.detectActivity(session)).not.toBe("blocked");
    });

    it("does NOT trigger blocked on 'failed' in normal code output", async () => {
      mockTmuxWithActivity("Tests: 12 passed, 0 failed");
      const session = makeSession({ runtimeHandle: makeTmuxHandle() });
      expect(await agent.detectActivity(session)).not.toBe("blocked");
    });
  });

  it("returns idle (not exited) when capture-pane output is empty but process alive", async () => {
    mockTmuxWithActivity("");
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    // Process was confirmed alive by findClaudeProcess, empty pane ≠ exited
    expect(await agent.detectActivity(session)).toBe("idle");
  });

  it("returns active when capture-pane throws (process is alive)", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes")
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  123 ttys001  claude\n",
          stderr: "",
        });
      if (cmd === "tmux" && args[0] === "capture-pane")
        return Promise.reject(new Error("tmux server not found"));
      return Promise.reject(new Error("unexpected"));
    });
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    expect(await agent.detectActivity(session)).toBe("active");
  });

  it("defaults to active for unrecognised output", async () => {
    mockTmuxWithActivity("Just some random text that matches nothing");
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    expect(await agent.detectActivity(session)).toBe("active");
  });

  it("active takes priority over blocked keywords in same output", async () => {
    mockTmuxWithActivity("Thinking about the Error: handling code");
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    expect(await agent.detectActivity(session)).toBe("active");
  });

  it("handles non-tmux runtime: returns active when process alive but no output", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const session = makeSession({ runtimeHandle: makeProcessHandle(555) });
    // findClaudeProcess confirms alive via process.kill(555,0)
    // No tmux pane → output stays null → returns "active" (can't determine state)
    expect(await agent.detectActivity(session)).toBe("active");
    killSpy.mockRestore();
  });

  it("idle prompt overrides stale blocked errors in buffer", async () => {
    // Buffer contains a blocked error from earlier, but the agent has since
    // recovered and is now at its idle prompt — idle should take priority.
    mockTmuxWithActivity("Error: module not found\nsome output\n❯ \n");
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    expect(await agent.detectActivity(session)).toBe("idle");
  });
});

// =========================================================================
// introspect — JSONL parsing
// =========================================================================
describe("introspect", () => {
  const agent = create();

  it("returns null when workspacePath is null", async () => {
    expect(await agent.introspect(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when project directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await agent.introspect(makeSession())).toBeNull();
  });

  it("returns null when no JSONL files in project dir", async () => {
    mockReaddir.mockResolvedValue(["readme.txt", "config.yaml"]);
    expect(await agent.introspect(makeSession())).toBeNull();
  });

  it("filters out agent- prefixed JSONL files", async () => {
    mockReaddir.mockResolvedValue(["agent-toolkit.jsonl"]);
    expect(await agent.introspect(makeSession())).toBeNull();
  });

  it("returns null when JSONL file is empty", async () => {
    mockJsonlFiles("");
    expect(await agent.introspect(makeSession())).toBeNull();
  });

  it("returns null when JSONL has only malformed lines", async () => {
    mockJsonlFiles("not json\nalso not json\n");
    expect(await agent.introspect(makeSession())).toBeNull();
  });

  describe("path conversion", () => {
    it("converts workspace path to Claude project dir path", async () => {
      mockJsonlFiles('{"type":"user","message":{"content":"hello"}}');
      await agent.introspect(makeSession({ workspacePath: "/Users/dev/.worktrees/ao/ao-3" }));
      expect(mockReaddir).toHaveBeenCalledWith(
        "/mock/home/.claude/projects/Users-dev--worktrees-ao-ao-3",
      );
    });
  });

  describe("summary extraction", () => {
    it("extracts summary from last summary event", async () => {
      const jsonl = [
        '{"type":"summary","summary":"First summary"}',
        '{"type":"user","message":{"content":"do something"}}',
        '{"type":"summary","summary":"Latest summary"}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.summary).toBe("Latest summary");
    });

    it("falls back to first user message when no summary", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"Implement the login feature"}}',
        '{"type":"assistant","message":{"content":"I will implement..."}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.summary).toBe("Implement the login feature");
    });

    it("truncates long user message to 120 chars", async () => {
      const longMsg = "A".repeat(200);
      const jsonl = `{"type":"user","message":{"content":"${longMsg}"}}`;
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.summary).toBe("A".repeat(120) + "...");
      expect(result!.summary!.length).toBe(123);
    });

    it("returns null summary when no summary and no user messages", async () => {
      const jsonl = '{"type":"assistant","message":{"content":"Hello"}}';
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.summary).toBeNull();
    });

    it("skips user messages with empty content", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"   "}}',
        '{"type":"user","message":{"content":"Real content"}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.summary).toBe("Real content");
    });
  });

  describe("session ID extraction", () => {
    it("extracts session ID from filename", async () => {
      mockJsonlFiles('{"type":"user","message":{"content":"hi"}}', ["abc-def-123.jsonl"]);
      const result = await agent.introspect(makeSession());
      expect(result?.agentSessionId).toBe("abc-def-123");
    });
  });

  describe("last message type", () => {
    it("returns the type of the last JSONL line", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"test"}}',
        '{"type":"assistant","message":{"content":"response"}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.lastMessageType).toBe("assistant");
    });

    it("returns undefined when no lines have type", async () => {
      mockJsonlFiles('{"content":"no type field"}');
      const result = await agent.introspect(makeSession());
      expect(result?.lastMessageType).toBeUndefined();
    });
  });

  describe("cost estimation", () => {
    it("aggregates usage.input_tokens and usage.output_tokens", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","usage":{"input_tokens":1000,"output_tokens":500}}',
        '{"type":"assistant","usage":{"input_tokens":2000,"output_tokens":300}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.cost?.inputTokens).toBe(3000);
      expect(result?.cost?.outputTokens).toBe(800);
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.009 + 0.012, 6);
    });

    it("includes cache tokens in input count", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":500,"cache_creation_input_tokens":200}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.cost?.inputTokens).toBe(800);
      expect(result?.cost?.outputTokens).toBe(50);
    });

    it("uses costUSD field when present", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"costUSD":0.05}',
        '{"costUSD":0.03}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.08);
    });

    it("prefers costUSD over estimatedCostUsd to avoid double-counting", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"costUSD":0.10,"estimatedCostUsd":0.10}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      // Should use costUSD only, not sum both
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.1);
    });

    it("falls back to estimatedCostUsd when costUSD is absent", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"estimatedCostUsd":0.12}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.12);
    });

    it("uses direct inputTokens/outputTokens fields", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"inputTokens":5000,"outputTokens":1000}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.cost?.inputTokens).toBe(5000);
      expect(result?.cost?.outputTokens).toBe(1000);
    });

    it("returns undefined cost when no usage data", async () => {
      const jsonl = '{"type":"user","message":{"content":"hi"}}';
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.cost).toBeUndefined();
    });
  });

  describe("file selection", () => {
    it("picks the most recently modified JSONL file", async () => {
      mockReaddir.mockResolvedValue(["old.jsonl", "new.jsonl"]);
      mockStat.mockImplementation((path: string) => {
        if (path.endsWith("old.jsonl")) {
          return Promise.resolve({ mtimeMs: 1000, mtime: new Date(1000) });
        }
        return Promise.resolve({ mtimeMs: 2000, mtime: new Date(2000) });
      });
      mockReadFile.mockResolvedValue('{"type":"user","message":{"content":"hi"}}');
      const result = await agent.introspect(makeSession());
      expect(result?.agentSessionId).toBe("new");
    });

    it("skips JSONL files that fail stat", async () => {
      mockReaddir.mockResolvedValue(["broken.jsonl", "good.jsonl"]);
      mockStat.mockImplementation((path: string) => {
        if (path.endsWith("broken.jsonl")) {
          return Promise.reject(new Error("ENOENT"));
        }
        return Promise.resolve({ mtimeMs: 1000, mtime: new Date(1000) });
      });
      mockReadFile.mockResolvedValue('{"type":"user","message":{"content":"hi"}}');
      const result = await agent.introspect(makeSession());
      expect(result?.agentSessionId).toBe("good");
    });
  });

  describe("lastLogModified", () => {
    it("returns file mtime as lastLogModified", async () => {
      const mtime = new Date(1700000000000);
      mockJsonlFiles('{"type":"user","message":{"content":"hi"}}', undefined, mtime);
      const result = await agent.introspect(makeSession());
      expect(result?.lastLogModified).toEqual(mtime);
    });
  });

  describe("malformed JSONL handling", () => {
    it("skips malformed lines and parses valid ones", async () => {
      const jsonl = [
        "not valid json",
        '{"type":"summary","summary":"Good summary"}',
        "{truncated",
        "",
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.summary).toBe("Good summary");
    });

    it("skips JSON null, array, and primitive values", async () => {
      const jsonl = [
        "null",
        "42",
        '"just a string"',
        "[1,2,3]",
        '{"type":"summary","summary":"Valid object"}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.introspect(makeSession());
      expect(result?.summary).toBe("Valid object");
    });

    it("handles readFile failure gracefully", async () => {
      mockReaddir.mockResolvedValue(["session.jsonl"]);
      mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });
      mockReadFile.mockRejectedValue(new Error("EACCES"));
      const result = await agent.introspect(makeSession());
      expect(result).toBeNull();
    });
  });
});
