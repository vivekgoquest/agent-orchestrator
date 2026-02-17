/**
 * Server compatibility tests.
 *
 * These tests verify that the terminal server files are compatible with
 * the hash-based architecture. They read source files and check for
 * deprecated patterns that would cause runtime failures.
 *
 * These tests would have caught the breakage from PR #58 where
 * config.dataDir was removed but terminal servers still referenced it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverDir = join(__dirname, "..");

function readServerFile(name: string): string {
  return readFileSync(join(serverDir, name), "utf-8");
}

describe("direct-terminal-ws.ts", () => {
  const source = readServerFile("direct-terminal-ws.ts");

  it("does not import loadConfig from @composio/ao-core", () => {
    // loadConfig was used to get config.dataDir which no longer exists
    // on OrchestratorConfig. The server should validate sessions via tmux directly.
    expect(source).not.toMatch(/import\s.*loadConfig.*from\s+["']@composio\/ao-core["']/);
  });

  it("does not reference config.dataDir", () => {
    // config.dataDir was removed in the hash-based architecture migration.
    // Session validation should use tmux has-session instead.
    expect(source).not.toMatch(/config\.dataDir/);
  });

  it("does not use bare 'tmux' string for ptySpawn", () => {
    // node-pty's posix_spawnp doesn't reliably inherit PATH.
    // Must use full path to tmux binary.
    expect(source).not.toMatch(/ptySpawn\(\s*["']tmux["']/);
  });

  it("validates sessions via tmux has-session, not file existence", () => {
    // Session metadata lives in hash-based directories now.
    // Checking file existence with old paths would always fail.
    expect(source).not.toMatch(/existsSync.*session/i);
    expect(source).toMatch(/has-session/);
  });

  it("resolves hash-prefixed tmux session names", () => {
    // User-facing IDs (ao-15) differ from tmux names (8474d6f29887-ao-15).
    // Server must resolve the mapping.
    expect(source).toMatch(/resolveTmuxSession|resolve.*tmux.*session/i);
  });

  it("discovers tmux binary path explicitly", () => {
    // node-pty needs explicit path, not just "tmux"
    expect(source).toMatch(/findTmux|\/opt\/homebrew\/bin\/tmux|\/usr\/local\/bin\/tmux/);
  });
});

describe("terminal-websocket.ts", () => {
  const source = readServerFile("terminal-websocket.ts");

  it("does not import loadConfig from @composio/ao-core", () => {
    expect(source).not.toMatch(/import\s.*loadConfig.*from\s+["']@composio\/ao-core["']/);
  });

  it("does not reference config.dataDir", () => {
    expect(source).not.toMatch(/config\.dataDir/);
  });

  it("validates sessions via tmux, not file existence", () => {
    expect(source).not.toMatch(/existsSync.*session/i);
    expect(source).toMatch(/has-session/);
  });

  it("resolves hash-prefixed tmux session names", () => {
    // Like direct-terminal-ws, the ttyd server must resolve user-facing IDs
    // to hash-prefixed tmux names (e.g., "ao-15" → "8474d6f29887-ao-15").
    expect(source).toMatch(/resolveTmuxSession|resolve.*tmux.*session/i);
  });

  it("discovers tmux binary path explicitly", () => {
    // Should use findTmux() or hardcoded paths, not bare "tmux"
    expect(source).toMatch(/findTmux|\/opt\/homebrew\/bin\/tmux|\/usr\/local\/bin\/tmux/);
  });
});

describe("tmux exact matching", () => {
  it("direct-terminal-ws uses exact match prefix for has-session", () => {
    // tmux has-session -t uses prefix matching by default.
    // "ao-1" would match "ao-15". Use = prefix for exact matching: -t =sessionId
    const source = readServerFile("direct-terminal-ws.ts");
    expect(source).toMatch(/has-session.*=\$\{|has-session.*`=|"=\$\{sessionId\}"|`=\$\{sessionId\}`/);
  });

  it("terminal-websocket uses exact match prefix for has-session", () => {
    const source = readServerFile("terminal-websocket.ts");
    expect(source).toMatch(/has-session.*=\$\{|has-session.*`=|"=\$\{sessionId\}"|`=\$\{sessionId\}`/);
  });
});

describe("OrchestratorConfig compatibility", () => {
  it("OrchestratorConfig does not have dataDir property", async () => {
    // This test verifies the type-level change that broke the servers.
    // If someone adds dataDir back, these server tests may give false confidence.
    const { loadConfig } = await import("@composio/ao-core");

    // Create a dummy config to inspect the shape
    // loadConfig() would throw without a file, so we check the type system
    // by verifying the interface doesn't include dataDir
    const typesSource = readFileSync(
      join(__dirname, "..", "..", "..", "core", "src", "types.ts"),
      "utf-8",
    );

    // Extract OrchestratorConfig interface block
    const configMatch = typesSource.match(
      /export interface OrchestratorConfig \{[\s\S]*?\n\}/,
    );
    expect(configMatch).toBeTruthy();
    const configBlock = configMatch![0];

    // dataDir should NOT be in OrchestratorConfig
    expect(configBlock).not.toMatch(/dataDir/);
    // configPath SHOULD be in OrchestratorConfig
    expect(configBlock).toMatch(/configPath/);
  });
});
