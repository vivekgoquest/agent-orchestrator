import type {
  Agent,
  AgentIntrospection,
  AgentLaunchConfig,
  ActivityState,
  CostEstimate,
  PluginModule,
  RuntimeHandle,
  Session,
} from "@agent-orchestrator/core";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "claude-code",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code CLI",
  version: "0.1.0",
};

// =============================================================================
// JSONL Helpers
// =============================================================================

/**
 * Convert a workspace path to Claude's project directory path.
 * Claude stores sessions at ~/.claude/projects/{encoded-path}/
 *
 * Verified against Claude Code's actual encoding (as of v1.x):
 * the path has its leading / stripped, then all / and . are replaced with -.
 * e.g. /Users/dev/.worktrees/ao → Users-dev--worktrees-ao
 *
 * If Claude Code changes its encoding scheme this will silently break
 * introspection. The path can be validated at runtime by checking whether
 * the resulting directory exists.
 */
function toClaudeProjectPath(workspacePath: string): string {
  return workspacePath.replace(/^\//, "").replace(/[/.]/g, "-");
}

/** Find the most recently modified .jsonl session file in a directory */
async function findLatestSessionFile(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  if (jsonlFiles.length === 0) return null;

  // Sort by mtime descending
  const withStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const fullPath = join(projectDir, f);
      try {
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtimeMs };
      } catch {
        return { path: fullPath, mtime: 0 };
      }
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats[0]?.path ?? null;
}

interface JsonlLine {
  type?: string;
  summary?: string;
  message?: { content?: string; role?: string };
  // Cost/usage fields
  costUSD?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

/** Parse JSONL file into lines (skipping invalid JSON) */
async function parseJsonlFile(filePath: string): Promise<JsonlLine[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const lines: JsonlLine[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as JsonlLine);
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

/** Extract auto-generated summary from JSONL (last "summary" type entry) */
function extractSummary(lines: JsonlLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type === "summary" && line.summary) {
      return line.summary;
    }
  }
  // Fallback: first user message truncated to 120 chars
  for (const line of lines) {
    if (
      line?.type === "user" &&
      line.message?.content &&
      typeof line.message.content === "string"
    ) {
      const msg = line.message.content.trim();
      if (msg.length > 0) {
        return msg.length > 120 ? msg.substring(0, 120) + "..." : msg;
      }
    }
  }
  return null;
}

/** Extract the last message type from JSONL */
function extractLastMessageType(lines: JsonlLine[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type) return line.type;
  }
  return undefined;
}

/** Aggregate cost estimate from JSONL usage events */
function extractCost(lines: JsonlLine[]): CostEstimate | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;

  for (const line of lines) {
    // Handle direct cost fields — prefer costUSD; only use estimatedCostUsd
    // as fallback to avoid double-counting when both are present.
    if (typeof line.costUSD === "number") {
      totalCost += line.costUSD;
    } else if (typeof line.estimatedCostUsd === "number") {
      totalCost += line.estimatedCostUsd;
    }
    // Handle token counts — prefer the structured `usage` object when present;
    // only fall back to flat `inputTokens`/`outputTokens` fields to avoid
    // double-counting if a line contains both.
    if (line.usage) {
      inputTokens += line.usage.input_tokens ?? 0;
      inputTokens += line.usage.cache_read_input_tokens ?? 0;
      inputTokens += line.usage.cache_creation_input_tokens ?? 0;
      outputTokens += line.usage.output_tokens ?? 0;
    } else {
      if (typeof line.inputTokens === "number") {
        inputTokens += line.inputTokens;
      }
      if (typeof line.outputTokens === "number") {
        outputTokens += line.outputTokens;
      }
    }
  }

  if (inputTokens === 0 && outputTokens === 0 && totalCost === 0) {
    return undefined;
  }

  // Rough estimate when no direct cost data — uses Sonnet 4.5 pricing as a
  // baseline. Will be inaccurate for other models (Opus, Haiku) but provides
  // a useful order-of-magnitude signal. TODO: make pricing configurable or
  // infer from model field in JSONL.
  if (totalCost === 0 && (inputTokens > 0 || outputTokens > 0)) {
    totalCost = (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0;
  }

  return { inputTokens, outputTokens, estimatedCostUsd: totalCost };
}

// =============================================================================
// Shell Escaping
// =============================================================================

/**
 * POSIX-safe shell escaping: wraps value in single quotes,
 * escaping any embedded single quotes as '\'' .
 */
function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// =============================================================================
// Activity Detection Patterns
// =============================================================================

/**
 * Patterns indicating Claude is actively processing.
 *
 * Stable indicators: "⏺" (the recording dot), "esc to interrupt".
 * The animated thinking words (Thinking, Pondering, etc.) are Claude CLI
 * internal UX that may change between versions — listed here as best-effort
 * but the first two are the most reliable.
 */
const ACTIVE_PATTERNS = /\u23FA|esc to interrupt|Thinking|Pondering|Analyzing/;

/** Patterns indicating Claude is at the prompt (idle) */
const IDLE_PATTERNS = /^[❯>]\s*$/m;

/** Patterns indicating Claude is asking for input */
const INPUT_PATTERNS =
  /\[y\/N\]|\[Y\/n\]|Continue\?|Proceed\?|Do you want|Allow|Approve|Permission/i;

/**
 * Patterns indicating Claude is blocked or errored.
 * Intentionally specific to avoid false positives from code output the agent
 * is working on (e.g. "Fixed the error in auth.ts" should NOT trigger blocked).
 */
const BLOCKED_PATTERNS =
  /^Error:|^✗|ENOENT:|EACCES:|quota exceeded|rate limit exceeded|APIError:|NetworkError:/m;

// =============================================================================
// Process Detection
// =============================================================================

/**
 * Check if a process named "claude" is running in the given runtime handle's context.
 * Uses ps to find processes by TTY (for tmux) or by PID.
 */
async function findClaudeProcess(handle: RuntimeHandle): Promise<number | null> {
  try {
    // For tmux runtime, get the pane TTY and find claude on it
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync("tmux", [
        "list-panes",
        "-t",
        handle.id,
        "-F",
        "#{pane_tty}",
      ]);
      // Iterate all pane TTYs (multi-pane sessions) — succeed on any match
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return null;

      // Use `args` instead of `comm` so we can match the CLI name even when
      // the process runs via a wrapper (e.g. node, python).  `comm` would
      // report "node" instead of "claude" in those cases.
      const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"]);
      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      // Match "claude" as a word boundary — prevents false positives on
      // names like "claude-code" or paths that merely contain the substring.
      const processRe = /(?:^|\/)claude(?:\s|$)/;
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) {
          return parseInt(cols[0] ?? "0", 10);
        }
      }
      return null;
    }

    // For process runtime, check if the PID stored in handle data is alive
    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // Signal 0 = check existence
        return pid;
      } catch (err: unknown) {
        // EPERM means the process exists but we lack permission to signal it
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return pid;
        }
        return null;
      }
    }

    // No reliable way to identify the correct process for this session
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createClaudeCodeAgent(): Agent {
  return {
    name: "claude-code",
    processName: "claude",

    getLaunchCommand(config: AgentLaunchConfig): string {
      // Note: CLAUDECODE is unset via getEnvironment() (set to ""), not here.
      // This command must be safe for both shell and execFile contexts.
      const parts: string[] = ["claude"];

      if (config.permissions === "skip") {
        parts.push("--dangerously-skip-permissions");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.prompt) {
        parts.push("-p", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};

      // Unset CLAUDECODE to avoid nested agent conflicts
      env["CLAUDECODE"] = "";

      // Set session info for introspection
      env["AO_SESSION_ID"] = config.sessionId;
      env["AO_PROJECT_ID"] = config.projectConfig.name;

      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      return env;
    },

    async detectActivity(session: Session): Promise<ActivityState> {
      // If no runtime handle, agent can't be running
      if (!session.runtimeHandle) return "exited";

      // Check if process is actually running
      const pid = await findClaudeProcess(session.runtimeHandle);
      if (pid === null) return "exited";

      // Try to get terminal output for pattern matching
      // This requires the runtime plugin to be available, so we check handle data
      let output: string | null = null;
      try {
        if (session.runtimeHandle.runtimeName === "tmux") {
          const { stdout } = await execFileAsync("tmux", [
            "capture-pane",
            "-t",
            session.runtimeHandle.id,
            "-p",
            "-S",
            "-15",
          ]);
          output = stdout;
        }
      } catch {
        // If we can't get output, just confirm process is alive
        return "active";
      }

      // Empty/null output with a confirmed-alive process means the pane
      // hasn't rendered yet or was cleared — not that the process exited.
      if (!output || output.trim() === "") return "idle";

      // Check patterns in priority order.
      // Blocked before input: error messages like "EACCES: permission denied"
      // contain words ("permission") that INPUT_PATTERNS would match.
      if (ACTIVE_PATTERNS.test(output)) return "active";
      if (BLOCKED_PATTERNS.test(output)) return "blocked";
      if (INPUT_PATTERNS.test(output)) return "waiting_input";
      if (IDLE_PATTERNS.test(output)) return "idle";

      // Default: if process is running but no clear pattern, assume active
      return "active";
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const pid = await findClaudeProcess(handle);
      return pid !== null;
    },

    async introspect(session: Session): Promise<AgentIntrospection | null> {
      if (!session.workspacePath) return null;

      // Build the Claude project directory path
      const projectPath = toClaudeProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".claude", "projects", projectPath);

      // Find the latest session JSONL file
      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) return null;

      // Get file modification time
      let lastLogModified: Date | undefined;
      try {
        const fileStat = await stat(sessionFile);
        lastLogModified = fileStat.mtime;
      } catch {
        // Ignore stat errors
      }

      // Parse the JSONL
      const lines = await parseJsonlFile(sessionFile);
      if (lines.length === 0) return null;

      // Extract session ID from filename
      const agentSessionId = basename(sessionFile, ".jsonl");

      return {
        summary: extractSummary(lines),
        agentSessionId,
        cost: extractCost(lines),
        lastMessageType: extractLastMessageType(lines),
        lastLogModified,
      };
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createClaudeCodeAgent();
}

const plugin: PluginModule<Agent> = { manifest, create };
export default plugin;
