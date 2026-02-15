import {
  shellEscape,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// =============================================================================
// Codex Session File Helpers
// =============================================================================

/**
 * Find the latest rollout-*.jsonl file in Codex session directory.
 * Codex stores session files at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
async function findLatestRolloutFile(sessionId: string): Promise<string | null> {
  try {
    const codexDir = join(homedir(), ".codex", "sessions");
    const now = new Date();

    // Try current date and previous 7 days
    for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
      const date = new Date(now);
      date.setDate(date.getDate() - daysAgo);

      const year = date.getFullYear().toString();
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      const day = date.getDate().toString().padStart(2, "0");

      const dayDir = join(codexDir, year, month, day);

      try {
        const files = await readdir(dayDir);
        const rolloutFiles = files
          .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
          .filter((f) => f.includes(sessionId) || sessionId.startsWith(f.slice(8, -6)));

        if (rolloutFiles.length > 0) {
          // Get the most recent by mtime
          const fileStats = await Promise.all(
            rolloutFiles.map(async (f) => ({
              name: f,
              mtime: (await stat(join(dayDir, f))).mtime,
            })),
          );
          fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
          return join(dayDir, fileStats[0].name);
        }
      } catch {
        // Directory doesn't exist, try next date
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Read the last entry from a JSONL file and return type + mtime.
 */
async function readLastJsonlEntry(
  filePath: string,
): Promise<{ lastType: string; modifiedAt: Date } | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine) as { type?: string };
    const stats = await stat(filePath);

    return {
      lastType: entry.type ?? "unknown",
      modifiedAt: stats.mtime,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "codex",
  slot: "agent" as const,
  description: "Agent plugin: OpenAI Codex CLI",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createCodexAgent(): Agent {
  return {
    name: "codex",
    processName: "codex",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["codex"];

      if (config.permissions === "skip") {
        parts.push("--approval-mode", "full-auto");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.prompt) {
        // Use `--` to end option parsing so prompts starting with `-` aren't
        // misinterpreted as flags.
        parts.push("--", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      env["AO_PROJECT_ID"] = config.projectConfig.name;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";
      // Codex doesn't have rich terminal output patterns yet
      return "active";
    },

    async getActivityState(session: Session): Promise<ActivityState> {
      // Check if process is running first
      if (!session.runtimeHandle) return "exited";
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return "exited";

      // Process is running - check JSONL rollout file for activity
      const rolloutFile = await findLatestRolloutFile(session.id);
      if (!rolloutFile) {
        // No session file found, but process is running - assume active
        return "active";
      }

      const entry = await readLastJsonlEntry(rolloutFile);
      if (!entry) return "idle";

      // Check if file was modified recently (within 30 seconds)
      const ageMs = Date.now() - entry.modifiedAt.getTime();
      if (ageMs > 30_000) return "idle";

      // Map Codex event types to activity states
      // Codex JSONL events: user_message, assistant_message, tool_use, tool_result, approval_request, error
      switch (entry.lastType) {
        case "user_message":
        case "tool_use":
        case "tool_result":
          return "active";
        case "assistant_message":
          return "idle";
        case "approval_request":
          return "waiting_input";
        case "error":
          return "blocked";
        default:
          return "active";
      }
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync("tmux", [
            "list-panes",
            "-t",
            handle.id,
            "-F",
            "#{pane_tty}",
          ], { timeout: 30_000 });
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], { timeout: 30_000 });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)codex(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code === "EPERM") {
              return true;
            }
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
    },

    // NOTE: Codex lacks introspection to distinguish "processing" from "idle at prompt".
    // Falling back to process liveness until richer detection is implemented (see #17).
    async isProcessing(session: Session): Promise<boolean> {
      if (!session.runtimeHandle) return false;
      return this.isProcessRunning(session.runtimeHandle);
    },

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // Codex doesn't have JSONL session files for introspection yet
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCodexAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
