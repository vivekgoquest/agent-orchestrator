import type {
  Agent,
  AgentIntrospection,
  AgentLaunchConfig,
  ActivityState,
  PluginModule,
  RuntimeHandle,
  Session,
} from "@agent-orchestrator/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "aider",
  slot: "agent" as const,
  description: "Agent plugin: Aider",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

/**
 * POSIX-safe shell escaping: wraps value in single quotes,
 * escaping any embedded single quotes as '\'' .
 */
function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function createAiderAgent(): Agent {
  return {
    name: "aider",
    processName: "aider",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["aider"];

      if (config.permissions === "skip") {
        parts.push("--yes");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.prompt) {
        parts.push("--message", shellEscape(config.prompt));
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

    async detectActivity(session: Session): Promise<ActivityState> {
      if (!session.runtimeHandle) return "exited";

      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return "exited";

      // Aider doesn't have rich terminal output patterns yet
      return "active";
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
          ]);
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"]);
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)aider(?:\s|$)/;
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

    async introspect(_session: Session): Promise<AgentIntrospection | null> {
      // Aider doesn't have JSONL session files for introspection yet
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAiderAgent();
}

const plugin: PluginModule<Agent> = { manifest, create };
export default plugin;
