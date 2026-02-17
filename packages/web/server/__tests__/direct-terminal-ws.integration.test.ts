/**
 * Integration tests for direct-terminal-ws.
 *
 * These start the real server, create real tmux sessions, connect via
 * WebSocket, and verify the full flow works end-to-end — exactly what
 * a user's browser does when opening a terminal on the dashboard.
 *
 * These tests would have caught the PR #58 breakage because:
 * - The server would fail to start (loadConfig crash)
 * - Session resolution would fail (config.dataDir doesn't exist)
 * - WebSocket connections would be rejected (no tmux session match)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { findTmux } from "../tmux-utils.js";
import { createDirectTerminalServer, type DirectTerminalServer } from "../direct-terminal-ws.js";

const TMUX = findTmux();
const TEST_SESSION = `ao-test-integration-${process.pid}`;
const TEST_HASH_SESSION = `abcdef123456-${TEST_SESSION}`;

let terminal: DirectTerminalServer;
let port: number;

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "localhost", port, path, method: "GET", timeout: 3000 },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function connectWs(sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=${sessionId}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    // Give it 5s to connect
    setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
  });
}

function waitForWsClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
    // Safety timeout
    setTimeout(() => resolve({ code: -1, reason: "timeout" }), 5000);
  });
}

function waitForWsData(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const handler = (data: Buffer | string) => {
      buf += data.toString();
      // tmux sends terminal output — any data means the connection works
      if (buf.length > 0) {
        ws.off("message", handler);
        resolve(buf);
      }
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      if (buf.length > 0) resolve(buf);
      else reject(new Error("No data received from terminal"));
    }, timeoutMs);
  });
}

beforeAll(() => {
  // Create test tmux sessions
  execFileSync(TMUX, ["new-session", "-d", "-s", TEST_SESSION, "-x", "80", "-y", "24"], { timeout: 5000 });
  execFileSync(TMUX, ["new-session", "-d", "-s", TEST_HASH_SESSION, "-x", "80", "-y", "24"], { timeout: 5000 });

  // Start the server on a random port
  terminal = createDirectTerminalServer(TMUX);
  terminal.server.listen(0);
  const addr = terminal.server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterEach(() => {
  // Clean up any active sessions from tests
  for (const [, session] of terminal.activeSessions) {
    session.pty.kill();
    session.ws.close();
  }
  terminal.activeSessions.clear();
});

afterAll(() => {
  // Shut down server
  terminal.shutdown();

  // Kill test tmux sessions
  try { execFileSync(TMUX, ["kill-session", "-t", TEST_SESSION], { timeout: 5000 }); } catch { /* already dead */ }
  try { execFileSync(TMUX, ["kill-session", "-t", TEST_HASH_SESSION], { timeout: 5000 }); } catch { /* already dead */ }
});

describe("health endpoint", () => {
  it("GET /health returns 200 with active session count", async () => {
    const res = await httpGet("/health");

    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("active");
    expect(data).toHaveProperty("sessions");
    expect(typeof data.active).toBe("number");
  });
});

describe("WebSocket connection validation", () => {
  it("rejects connection with no session parameter", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Missing session");
  });

  it("rejects connection with invalid session ID (path traversal)", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=../../../etc/passwd`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Invalid session ID");
  });

  it("rejects connection with shell injection in session ID", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=test;rm%20-rf%20/`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Invalid session ID");
  });

  it("rejects connection for nonexistent tmux session", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=ao-nonexistent-999`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Session not found");
  });
});

describe("WebSocket terminal connection", () => {
  it("connects to a real tmux session and receives terminal output", async () => {
    const ws = await connectWs(TEST_SESSION);

    // tmux sends terminal init sequences on attach
    const data = await waitForWsData(ws);
    expect(data.length).toBeGreaterThan(0);

    ws.close();
  });

  it("resolves hash-prefixed tmux session by suffix", async () => {
    // Connect using the user-facing part of the hash-prefixed session name
    // TEST_HASH_SESSION = "abcdef123456-ao-test-integration-PID"
    // We connect with TEST_SESSION = "ao-test-integration-PID"
    // resolveTmuxSession should find TEST_HASH_SESSION via suffix match
    //
    // But first, the exact match (TEST_SESSION) will succeed because we also
    // created that session. To test hash resolution, use a unique suffix.
    const hashOnlySession = `ao-hashtest-${process.pid}`;
    const hashPrefixedName = `deadbeef-${hashOnlySession}`;

    // Create only the hash-prefixed session (no exact match)
    execFileSync(TMUX, ["new-session", "-d", "-s", hashPrefixedName, "-x", "80", "-y", "24"], { timeout: 5000 });

    try {
      const ws = await connectWs(hashOnlySession);

      // Should have resolved and connected
      const data = await waitForWsData(ws);
      expect(data.length).toBeGreaterThan(0);

      ws.close();
    } finally {
      try { execFileSync(TMUX, ["kill-session", "-t", hashPrefixedName], { timeout: 5000 }); } catch { /* */ }
    }
  });

  it("can send input to the terminal", async () => {
    const ws = await connectWs(TEST_SESSION);

    // Wait for initial terminal output
    await waitForWsData(ws);

    // Send a command — "echo INTEGRATION_TEST_MARKER"
    ws.send("echo INTEGRATION_TEST_MARKER\n");

    // Wait for the echo to come back
    const output = await new Promise<string>((resolve) => {
      let buf = "";
      const handler = (data: Buffer | string) => {
        buf += data.toString();
        if (buf.includes("INTEGRATION_TEST_MARKER")) {
          ws.off("message", handler);
          resolve(buf);
        }
      };
      ws.on("message", handler);
      setTimeout(() => { ws.off("message", handler); resolve(buf); }, 3000);
    });

    expect(output).toContain("INTEGRATION_TEST_MARKER");

    ws.close();
  });

  it("handles resize messages", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Send a resize message (same format xterm.js FitAddon sends)
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    // If resize didn't crash, we can still send/receive
    ws.send("echo RESIZE_OK\n");
    const output = await new Promise<string>((resolve) => {
      let buf = "";
      const handler = (data: Buffer | string) => {
        buf += data.toString();
        if (buf.includes("RESIZE_OK")) {
          ws.off("message", handler);
          resolve(buf);
        }
      };
      ws.on("message", handler);
      setTimeout(() => { ws.off("message", handler); resolve(buf); }, 3000);
    });

    expect(output).toContain("RESIZE_OK");

    ws.close();
  });
});

describe("404 for unknown paths", () => {
  it("returns 404 for unknown HTTP path", async () => {
    const res = await httpGet("/unknown-path");
    expect(res.status).toBe(404);
  });
});
