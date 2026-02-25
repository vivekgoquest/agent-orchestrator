import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  EVIDENCE_METADATA_KEYS,
  initializeWorkerEvidenceArtifacts,
  parseWorkerEvidence,
} from "../evidence.js";

let workspacePath: string;

beforeEach(() => {
  workspacePath = join(tmpdir(), `ao-evidence-test-${randomUUID()}`);
  mkdirSync(workspacePath, { recursive: true });
});

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

describe("initializeWorkerEvidenceArtifacts", () => {
  it("creates evidence files and metadata pointers", () => {
    const result = initializeWorkerEvidenceArtifacts(workspacePath, "app-1");

    expect(existsSync(result.paths.commandLog)).toBe(true);
    expect(existsSync(result.paths.testsRun)).toBe(true);
    expect(existsSync(result.paths.changedPaths)).toBe(true);
    expect(existsSync(result.paths.knownRisks)).toBe(true);

    expect(result.metadata[EVIDENCE_METADATA_KEYS.commandLog]).toBe(result.paths.commandLog);
    expect(result.metadata[EVIDENCE_METADATA_KEYS.testsRun]).toBe(result.paths.testsRun);
    expect(result.metadata[EVIDENCE_METADATA_KEYS.changedPaths]).toBe(result.paths.changedPaths);
    expect(result.metadata[EVIDENCE_METADATA_KEYS.knownRisks]).toBe(result.paths.knownRisks);
  });
});

describe("parseWorkerEvidence", () => {
  it("parses complete evidence artifacts", () => {
    const { paths, metadata } = initializeWorkerEvidenceArtifacts(workspacePath, "app-1");

    writeFileSync(
      paths.commandLog,
      JSON.stringify({
        schemaVersion: "1",
        complete: true,
        entries: [{ command: "pnpm test", exitCode: 0 }],
      }),
    );
    writeFileSync(
      paths.testsRun,
      JSON.stringify({
        schemaVersion: "1",
        complete: true,
        tests: [{ command: "pnpm test", status: "passed" }],
      }),
    );
    writeFileSync(
      paths.changedPaths,
      JSON.stringify({
        schemaVersion: "1",
        complete: true,
        paths: ["packages/core/src/evidence.ts"],
      }),
    );
    writeFileSync(
      paths.knownRisks,
      JSON.stringify({
        schemaVersion: "1",
        complete: true,
        risks: [{ risk: "Large artifact payloads can be noisy", mitigation: "Use max size cap" }],
      }),
    );

    const parsed = parseWorkerEvidence({
      sessionId: "app-1",
      workspacePath,
      metadata,
    });

    expect(parsed.status).toBe("complete");
    expect(parsed.commandLog.items).toHaveLength(1);
    expect(parsed.testsRun.items).toHaveLength(1);
    expect(parsed.changedPaths.items).toContain("packages/core/src/evidence.ts");
    expect(parsed.knownRisks.items[0]?.risk).toContain("Large artifact payloads");
    expect(parsed.warnings).toEqual([]);
  });

  it("derives tests and changed paths from command log when artifacts are missing", () => {
    const { paths, metadata } = initializeWorkerEvidenceArtifacts(workspacePath, "app-1");

    writeFileSync(
      paths.commandLog,
      JSON.stringify({
        schemaVersion: "1",
        complete: true,
        entries: [
          { command: "pnpm test --filter @composio/ao-core", exitCode: 0 },
          { command: "git add packages/core/src/evidence.ts", exitCode: 0 },
        ],
      }),
    );
    unlinkSync(paths.testsRun);
    unlinkSync(paths.changedPaths);
    writeFileSync(
      paths.knownRisks,
      JSON.stringify({
        schemaVersion: "1",
        complete: true,
        risks: [{ risk: "Fallback data may be incomplete" }],
      }),
    );

    const parsed = parseWorkerEvidence({
      sessionId: "app-1",
      workspacePath,
      metadata,
    });

    expect(parsed.status).toBe("incomplete");
    expect(parsed.testsRun.status).toBe("fallback");
    expect(parsed.testsRun.items[0]?.command).toContain("pnpm test");
    expect(parsed.changedPaths.status).toBe("fallback");
    expect(parsed.changedPaths.items).toContain("packages/core/src/evidence.ts");
  });

  it("treats invalid JSON as corrupt and does not throw", () => {
    const { paths, metadata } = initializeWorkerEvidenceArtifacts(workspacePath, "app-1");

    writeFileSync(paths.commandLog, "{not-json");
    const parsed = parseWorkerEvidence({
      sessionId: "app-1",
      workspacePath,
      metadata,
    });

    expect(parsed.status).toBe("corrupt");
    expect(parsed.commandLog.status).toBe("corrupt");
    expect(parsed.commandLog.items).toEqual([]);
  });

  it("returns missing status when neither workspace path nor pointers are available", () => {
    const parsed = parseWorkerEvidence({
      sessionId: "app-1",
      workspacePath: null,
      metadata: {},
    });

    expect(parsed.status).toBe("missing");
    expect(parsed.warnings[0]).toContain("missing workspace path");
  });
});

