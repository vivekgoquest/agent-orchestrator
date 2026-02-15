/**
 * Claude Code Hooks Setup — automatic metadata updates via PostToolUse hook.
 *
 * This is CRITICAL for the dashboard to work. Without these hooks, PRs created
 * by agents won't appear on the dashboard because metadata files won't be updated.
 *
 * The PostToolUse hook fires after every Bash command and:
 * - Detects `gh pr create` → extracts PR URL → updates metadata
 * - Detects `git checkout -b` / `git switch -c` → extracts branch → updates metadata
 * - Detects `gh pr merge` → sets status=merged
 */

import { writeFileSync, existsSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Settings.json content for Claude Code PostToolUse hook.
 * Uses $CLAUDE_PROJECT_DIR to reference the metadata-updater.sh script.
 */
const SETTINGS_JSON = {
  hooks: {
    PostToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: '"$CLAUDE_PROJECT_DIR"/.claude/metadata-updater.sh',
            timeout: 5000,
          },
        ],
      },
    ],
  },
};

/**
 * Bash script for metadata-updater.sh.
 * This script is called after every Bash tool use and updates session metadata
 * based on git/gh commands.
 */
const METADATA_UPDATER_SCRIPT = `#!/usr/bin/env bash
# Metadata Updater Hook for Agent Orchestrator
#
# This PostToolUse hook automatically updates session metadata when:
# - gh pr create: extracts PR URL and writes to metadata
# - git checkout -b / git switch -c: extracts branch name and writes to metadata
# - gh pr merge: updates status to "merged"

set -euo pipefail

# Configuration
AO_DATA_DIR="\${AO_DATA_DIR:-$HOME/.ao-sessions}"

# Read hook input from stdin
input=$(cat)

# Extract fields from JSON (using jq if available, otherwise basic parsing)
if command -v jq &>/dev/null; then
  tool_name=$(echo "$input" | jq -r '.tool_name // empty')
  command=$(echo "$input" | jq -r '.tool_input.command // empty')
  output=$(echo "$input" | jq -r '.tool_response // empty')
  exit_code=$(echo "$input" | jq -r '.exit_code // 0')
else
  # Fallback: basic JSON parsing without jq
  tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  command=$(echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  output=$(echo "$input" | grep -o '"tool_response"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  exit_code=$(echo "$input" | grep -o '"exit_code"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || echo "0")
fi

# Only process successful commands (exit code 0)
if [[ "$exit_code" -ne 0 ]]; then
  echo '{}'
  exit 0
fi

# Only process Bash tool calls
if [[ "$tool_name" != "Bash" ]]; then
  echo '{}' # Empty JSON output
  exit 0
fi

# Validate AO_SESSION is set
if [[ -z "\${AO_SESSION:-}" ]]; then
  echo '{"systemMessage": "AO_SESSION environment variable not set, skipping metadata update"}'
  exit 0
fi

metadata_file="$AO_DATA_DIR/$AO_SESSION"

# Ensure metadata file exists
if [[ ! -f "$metadata_file" ]]; then
  echo '{"systemMessage": "Metadata file not found: '"$metadata_file"'"}'
  exit 0
fi

# Update a single key in metadata
update_metadata_key() {
  local key="$1"
  local value="$2"

  # Create temp file
  local temp_file="\${metadata_file}.tmp"

  # Escape special sed characters in value (& | / \\)
  local escaped_value=$(echo "$value" | sed 's/[&|\\/]/\\\\&/g')

  # Check if key already exists
  if grep -q "^$key=" "$metadata_file" 2>/dev/null; then
    # Update existing key
    sed "s|^$key=.*|$key=$escaped_value|" "$metadata_file" > "$temp_file"
  else
    # Append new key
    cp "$metadata_file" "$temp_file"
    echo "$key=$value" >> "$temp_file"
  fi

  # Atomic replace
  mv "$temp_file" "$metadata_file"
}

# ============================================================================
# Command Detection and Parsing
# ============================================================================

# Detect: gh pr create
if [[ "$command" =~ ^gh[[:space:]]+pr[[:space:]]+create ]]; then
  # Extract PR URL from output
  pr_url=$(echo "$output" | grep -Eo 'https://github[.]com/[^/]+/[^/]+/pull/[0-9]+' | head -1)

  if [[ -n "$pr_url" ]]; then
    update_metadata_key "pr" "$pr_url"
    update_metadata_key "status" "pr_open"
    echo '{"systemMessage": "Updated metadata: PR created at '"$pr_url"'"}'
    exit 0
  fi
fi

# Detect: git checkout -b <branch> or git switch -c <branch>
if [[ "$command" =~ ^git[[:space:]]+checkout[[:space:]]+-b[[:space:]]+([^[:space:]]+) ]] || \\
   [[ "$command" =~ ^git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"

  if [[ -n "$branch" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: git checkout <branch> (without -b) or git switch <branch> (without -c)
# Only update if the branch name looks like a feature branch (contains / or -)
if [[ "$command" =~ ^git[[:space:]]+checkout[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]] || \\
   [[ "$command" =~ ^git[[:space:]]+switch[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"

  # Avoid updating for checkout of commits/tags
  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: gh pr merge
if [[ "$command" =~ ^gh[[:space:]]+pr[[:space:]]+merge ]]; then
  update_metadata_key "status" "merged"
  echo '{"systemMessage": "Updated metadata: status = merged"}'
  exit 0
fi

# No matching command, exit silently
echo '{}'
exit 0
`;

/**
 * Setup Claude Code hooks in a project directory.
 * Creates .claude/settings.json and .claude/metadata-updater.sh.
 *
 * This MUST be called by `ao start` or `ao init` to ensure the dashboard works.
 */
export function setupClaudeHooks(projectPath: string): void {
  const claudeDir = join(projectPath, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const updaterPath = join(claudeDir, "metadata-updater.sh");

  // Create .claude directory if it doesn't exist
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Write settings.json (merge with existing if present)
  let settings = SETTINGS_JSON;
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      // Merge hooks (PostToolUse hook takes precedence)
      settings = {
        ...existing,
        hooks: {
          ...(existing.hooks || {}),
          PostToolUse: SETTINGS_JSON.hooks.PostToolUse,
        },
      };
    } catch {
      // Ignore parse errors, use default settings
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  // Write metadata-updater.sh
  writeFileSync(updaterPath, METADATA_UPDATER_SCRIPT, "utf-8");

  // Make script executable
  chmodSync(updaterPath, 0o755);
}

/**
 * Check if Claude hooks are set up in a project directory.
 */
export function hasClaudeHooks(projectPath: string): boolean {
  const settingsPath = join(projectPath, ".claude", "settings.json");
  const updaterPath = join(projectPath, ".claude", "metadata-updater.sh");
  return existsSync(settingsPath) && existsSync(updaterPath);
}
