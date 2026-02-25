/**
 * Worker Evidence Artifact Contract
 *
 * Defines the on-disk artifact schema used for machine-verifiable completion:
 * - command-log.json
 * - tests-run.json
 * - changed-paths.json
 * - known-risks.json
 *
 * Artifacts are discovered through metadata pointers with a safe fallback to
 * workspace-local defaults when pointers are missing.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { SessionId } from "./types.js";

export const WORKER_EVIDENCE_SCHEMA_VERSION = "1";
export const WORKER_EVIDENCE_DIR = ".ao/evidence";
export const DEFAULT_EVIDENCE_MAX_BYTES = 256 * 1024;
const MAX_EVIDENCE_ITEMS = 500;

export const EVIDENCE_METADATA_KEYS = {
  schemaVersion: "evidenceSchemaVersion",
  dir: "evidenceDir",
  commandLog: "evidenceCommandLog",
  testsRun: "evidenceTestsRun",
  changedPaths: "evidenceChangedPaths",
  knownRisks: "evidenceKnownRisks",
} as const;

export interface WorkerEvidencePaths {
  evidenceDir: string;
  commandLog: string;
  testsRun: string;
  changedPaths: string;
  knownRisks: string;
}

export interface CommandLogEntry {
  command: string;
  exitCode: number | null;
  timestamp?: string;
  cwd?: string;
  durationMs?: number;
}

export interface TestRunEntry {
  command: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  details?: string;
}

export interface KnownRiskEntry {
  risk: string;
  mitigation?: string;
}

export type EvidenceArtifactStatus = "ok" | "missing" | "corrupt" | "fallback";

interface ParsedArtifact<T> {
  path: string;
  status: EvidenceArtifactStatus;
  complete: boolean;
  items: T[];
  truncated?: boolean;
  error?: string;
}

export interface WorkerEvidenceParseResult {
  schemaVersion: string;
  status: "complete" | "incomplete" | "missing" | "corrupt";
  commandLog: ParsedArtifact<CommandLogEntry>;
  testsRun: ParsedArtifact<TestRunEntry>;
  changedPaths: ParsedArtifact<string>;
  knownRisks: ParsedArtifact<KnownRiskEntry>;
  warnings: string[];
}

type ParseContext = {
  maxBytes: number;
};

function defaultCommandLogPayload(): {
  schemaVersion: string;
  complete: boolean;
  entries: CommandLogEntry[];
} {
  return {
    schemaVersion: WORKER_EVIDENCE_SCHEMA_VERSION,
    complete: false,
    entries: [],
  };
}

function defaultTestsRunPayload(): {
  schemaVersion: string;
  complete: boolean;
  tests: TestRunEntry[];
} {
  return {
    schemaVersion: WORKER_EVIDENCE_SCHEMA_VERSION,
    complete: false,
    tests: [],
  };
}

function defaultChangedPathsPayload(): {
  schemaVersion: string;
  complete: boolean;
  paths: string[];
} {
  return {
    schemaVersion: WORKER_EVIDENCE_SCHEMA_VERSION,
    complete: false,
    paths: [],
  };
}

function defaultKnownRisksPayload(): {
  schemaVersion: string;
  complete: boolean;
  risks: KnownRiskEntry[];
} {
  return {
    schemaVersion: WORKER_EVIDENCE_SCHEMA_VERSION,
    complete: false,
    risks: [],
  };
}

function writeJsonIfMissing(path: string, payload: unknown): void {
  if (existsSync(path)) return;
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function normalizePathSafe(path: string): string {
  return normalize(path);
}

function isInsideWorkspace(candidatePath: string, workspacePath: string): boolean {
  const workspaceNorm = normalizePathSafe(resolve(workspacePath));
  const candidateNorm = normalizePathSafe(resolve(candidatePath));
  return candidateNorm === workspaceNorm || candidateNorm.startsWith(workspaceNorm + sep);
}

function resolveCandidatePath(
  candidate: string | undefined,
  workspacePath: string | null,
): string | null {
  if (!candidate) return null;
  const resolvedPath = isAbsolute(candidate)
    ? normalizePathSafe(candidate)
    : workspacePath
      ? normalizePathSafe(resolve(workspacePath, candidate))
      : null;
  if (!resolvedPath) return null;
  if (workspacePath && !isInsideWorkspace(resolvedPath, workspacePath)) {
    return null;
  }
  return resolvedPath;
}

function parseJsonObject(content: string): unknown | null {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function readBoundedJson(path: string, context: ParseContext): { data: unknown; error?: string } {
  if (!existsSync(path)) return { data: null, error: "missing" };
  try {
    const size = statSync(path).size;
    if (size > context.maxBytes) {
      return {
        data: null,
        error: `artifact exceeds max size (${size} > ${context.maxBytes} bytes)`,
      };
    }
    const content = readFileSync(path, "utf-8");
    const parsed = parseJsonObject(content);
    if (parsed === null) return { data: null, error: "invalid JSON" };
    return { data: parsed };
  } catch {
    return { data: null, error: "unreadable artifact" };
  }
}

function pickArray(source: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(source)) return source;
  if (typeof source !== "object" || source === null) return null;
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function pickBoolean(source: unknown, key: string): boolean {
  if (typeof source !== "object" || source === null) return false;
  const value = (source as Record<string, unknown>)[key];
  return value === true;
}

function toCommandLogEntry(item: unknown): CommandLogEntry | null {
  if (typeof item === "string") {
    const command = item.trim();
    if (!command) return null;
    return { command, exitCode: null };
  }

  if (typeof item !== "object" || item === null) return null;
  const command = (item as Record<string, unknown>)["command"];
  if (typeof command !== "string" || !command.trim()) return null;

  const exitCodeRaw = (item as Record<string, unknown>)["exitCode"];
  const timestamp = (item as Record<string, unknown>)["timestamp"];
  const cwd = (item as Record<string, unknown>)["cwd"];
  const durationMs = (item as Record<string, unknown>)["durationMs"];

  return {
    command: command.trim(),
    exitCode: typeof exitCodeRaw === "number" && Number.isFinite(exitCodeRaw) ? exitCodeRaw : null,
    timestamp: typeof timestamp === "string" ? timestamp : undefined,
    cwd: typeof cwd === "string" ? cwd : undefined,
    durationMs: typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : undefined,
  };
}

function toTestRunEntry(item: unknown): TestRunEntry | null {
  if (typeof item === "string") {
    const command = item.trim();
    if (!command) return null;
    return { command, status: "unknown" };
  }

  if (typeof item !== "object" || item === null) return null;
  const command = (item as Record<string, unknown>)["command"];
  if (typeof command !== "string" || !command.trim()) return null;
  const status = (item as Record<string, unknown>)["status"];
  const details = (item as Record<string, unknown>)["details"];

  const normalizedStatus =
    status === "passed" || status === "failed" || status === "skipped" || status === "unknown"
      ? status
      : "unknown";

  return {
    command: command.trim(),
    status: normalizedStatus,
    details: typeof details === "string" ? details : undefined,
  };
}

function toChangedPath(item: unknown): string | null {
  if (typeof item === "string") {
    const value = item.trim();
    return value ? value : null;
  }
  if (typeof item !== "object" || item === null) return null;
  const path = (item as Record<string, unknown>)["path"];
  if (typeof path !== "string") return null;
  const value = path.trim();
  return value ? value : null;
}

function toKnownRisk(item: unknown): KnownRiskEntry | null {
  if (typeof item === "string") {
    const risk = item.trim();
    if (!risk) return null;
    return { risk };
  }

  if (typeof item !== "object" || item === null) return null;
  const risk = (item as Record<string, unknown>)["risk"];
  if (typeof risk !== "string" || !risk.trim()) return null;
  const mitigation = (item as Record<string, unknown>)["mitigation"];

  return {
    risk: risk.trim(),
    mitigation: typeof mitigation === "string" ? mitigation : undefined,
  };
}

function clampItems<T>(items: T[]): { items: T[]; truncated: boolean } {
  if (items.length <= MAX_EVIDENCE_ITEMS) {
    return { items, truncated: false };
  }
  return { items: items.slice(0, MAX_EVIDENCE_ITEMS), truncated: true };
}

function parseArtifactArray<T>(
  artifactPath: string,
  keys: string[],
  converter: (item: unknown) => T | null,
  context: ParseContext,
): ParsedArtifact<T> {
  const read = readBoundedJson(artifactPath, context);
  if (read.error === "missing") {
    return { path: artifactPath, status: "missing", complete: false, items: [], error: "missing" };
  }
  if (read.error) {
    return { path: artifactPath, status: "corrupt", complete: false, items: [], error: read.error };
  }

  const array = pickArray(read.data, keys);
  if (!array) {
    return {
      path: artifactPath,
      status: "corrupt",
      complete: false,
      items: [],
      error: "expected an array payload",
    };
  }

  const parsed = clampItems(array.map(converter).filter((item): item is T => item !== null));
  return {
    path: artifactPath,
    status: "ok",
    complete: pickBoolean(read.data, "complete"),
    items: parsed.items,
    truncated: parsed.truncated,
  };
}

function parseCommandLogArtifact(
  artifactPath: string,
  context: ParseContext,
): ParsedArtifact<CommandLogEntry> {
  return parseArtifactArray(artifactPath, ["entries", "commands"], toCommandLogEntry, context);
}

function parseTestsRunArtifact(artifactPath: string, context: ParseContext): ParsedArtifact<TestRunEntry> {
  return parseArtifactArray(artifactPath, ["tests", "entries"], toTestRunEntry, context);
}

function parseChangedPathsArtifact(
  artifactPath: string,
  context: ParseContext,
): ParsedArtifact<string> {
  return parseArtifactArray(artifactPath, ["paths", "changedPaths"], toChangedPath, context);
}

function parseKnownRisksArtifact(
  artifactPath: string,
  context: ParseContext,
): ParsedArtifact<KnownRiskEntry> {
  return parseArtifactArray(artifactPath, ["risks", "entries"], toKnownRisk, context);
}

function deriveTestsFromCommandLog(entries: CommandLogEntry[]): {
  items: TestRunEntry[];
  truncated: boolean;
} {
  const seen = new Set<string>();
  const derived: TestRunEntry[] = [];
  const testPattern =
    /\b(vitest|jest|mocha|ava|pytest|go test|cargo test|pnpm test|npm test|yarn test|bun test|mvn test|gradle test)\b/i;
  let truncated = false;

  for (const entry of entries) {
    const command = entry.command.trim();
    if (!testPattern.test(command)) continue;
    if (seen.has(command)) continue;
    seen.add(command);
    derived.push({
      command,
      status:
        entry.exitCode === null
          ? "unknown"
          : entry.exitCode === 0
            ? "passed"
            : "failed",
      details: "derived from command log",
    });
    if (derived.length >= MAX_EVIDENCE_ITEMS) {
      truncated = true;
      break;
    }
  }

  return { items: derived, truncated };
}

function deriveChangedPathsFromCommandLog(entries: CommandLogEntry[]): {
  items: string[];
  truncated: boolean;
} {
  const derived: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const entry of entries) {
    const cmd = entry.command.trim();
    const match = cmd.match(/^git\s+(add|rm|mv|checkout|restore)\s+(.+)$/);
    if (!match) continue;
    const rawArgs = match[2]
      .split(/\s+/)
      .map((part) => part.replace(/^['"]|['"]$/g, "").trim())
      .filter(Boolean);
    for (const arg of rawArgs) {
      if (!arg || arg.startsWith("-")) continue;
      if (arg === "." || arg === "--") continue;
      if (seen.has(arg)) continue;
      seen.add(arg);
      derived.push(arg);
      if (derived.length >= MAX_EVIDENCE_ITEMS) {
        truncated = true;
        return { items: derived, truncated };
      }
    }
  }

  return { items: derived, truncated };
}

function addWarning(
  warnings: string[],
  label: string,
  artifact: { status: string; truncated?: boolean; error?: string },
): void {
  if (artifact.truncated) {
    warnings.push(`${label}: truncated to ${MAX_EVIDENCE_ITEMS} items`);
  }
  if (artifact.status === "ok") return;
  if (artifact.error) {
    warnings.push(`${label}: ${artifact.status} (${artifact.error})`);
    return;
  }
  warnings.push(`${label}: ${artifact.status}`);
}

export function getWorkerEvidencePaths(workspacePath: string, sessionId: SessionId): WorkerEvidencePaths {
  const evidenceDir = join(workspacePath, WORKER_EVIDENCE_DIR, sessionId);
  return {
    evidenceDir,
    commandLog: join(evidenceDir, "command-log.json"),
    testsRun: join(evidenceDir, "tests-run.json"),
    changedPaths: join(evidenceDir, "changed-paths.json"),
    knownRisks: join(evidenceDir, "known-risks.json"),
  };
}

export function buildWorkerEvidenceMetadata(paths: WorkerEvidencePaths): Record<string, string> {
  return {
    [EVIDENCE_METADATA_KEYS.schemaVersion]: WORKER_EVIDENCE_SCHEMA_VERSION,
    [EVIDENCE_METADATA_KEYS.dir]: paths.evidenceDir,
    [EVIDENCE_METADATA_KEYS.commandLog]: paths.commandLog,
    [EVIDENCE_METADATA_KEYS.testsRun]: paths.testsRun,
    [EVIDENCE_METADATA_KEYS.changedPaths]: paths.changedPaths,
    [EVIDENCE_METADATA_KEYS.knownRisks]: paths.knownRisks,
  };
}

export function initializeWorkerEvidenceArtifacts(
  workspacePath: string,
  sessionId: SessionId,
): { paths: WorkerEvidencePaths; metadata: Record<string, string> } {
  const paths = getWorkerEvidencePaths(workspacePath, sessionId);
  mkdirSync(paths.evidenceDir, { recursive: true });
  writeJsonIfMissing(paths.commandLog, defaultCommandLogPayload());
  writeJsonIfMissing(paths.testsRun, defaultTestsRunPayload());
  writeJsonIfMissing(paths.changedPaths, defaultChangedPathsPayload());
  writeJsonIfMissing(paths.knownRisks, defaultKnownRisksPayload());

  return {
    paths,
    metadata: buildWorkerEvidenceMetadata(paths),
  };
}

function resolveWorkerEvidencePathsFromMetadata(
  metadata: Record<string, string>,
  sessionId: SessionId,
  workspacePath: string | null,
): WorkerEvidencePaths | null {
  const defaultPaths = workspacePath ? getWorkerEvidencePaths(workspacePath, sessionId) : null;
  const evidenceDir =
    resolveCandidatePath(metadata[EVIDENCE_METADATA_KEYS.dir], workspacePath) ??
    defaultPaths?.evidenceDir ??
    null;
  if (!evidenceDir) return null;

  const commandLog =
    resolveCandidatePath(metadata[EVIDENCE_METADATA_KEYS.commandLog], workspacePath) ??
    (defaultPaths ? defaultPaths.commandLog : join(evidenceDir, "command-log.json"));
  const testsRun =
    resolveCandidatePath(metadata[EVIDENCE_METADATA_KEYS.testsRun], workspacePath) ??
    (defaultPaths ? defaultPaths.testsRun : join(evidenceDir, "tests-run.json"));
  const changedPaths =
    resolveCandidatePath(metadata[EVIDENCE_METADATA_KEYS.changedPaths], workspacePath) ??
    (defaultPaths ? defaultPaths.changedPaths : join(evidenceDir, "changed-paths.json"));
  const knownRisks =
    resolveCandidatePath(metadata[EVIDENCE_METADATA_KEYS.knownRisks], workspacePath) ??
    (defaultPaths ? defaultPaths.knownRisks : join(evidenceDir, "known-risks.json"));

  return {
    evidenceDir: isAbsolute(evidenceDir) ? evidenceDir : normalizePathSafe(resolve(evidenceDir)),
    commandLog,
    testsRun,
    changedPaths,
    knownRisks,
  };
}

export function parseWorkerEvidence(
  params: {
    sessionId: SessionId;
    workspacePath: string | null;
    metadata: Record<string, string>;
  },
  opts?: {
    maxBytes?: number;
  },
): WorkerEvidenceParseResult {
  const context: ParseContext = {
    maxBytes: opts?.maxBytes ?? DEFAULT_EVIDENCE_MAX_BYTES,
  };
  const warnings: string[] = [];

  const paths = resolveWorkerEvidencePathsFromMetadata(
    params.metadata,
    params.sessionId,
    params.workspacePath,
  );

  if (!paths) {
    return {
      schemaVersion: params.metadata[EVIDENCE_METADATA_KEYS.schemaVersion] ?? WORKER_EVIDENCE_SCHEMA_VERSION,
      status: "missing",
      commandLog: {
        path: "",
        status: "missing",
        complete: false,
        items: [],
        error: "workspace path unavailable; cannot resolve evidence paths",
      },
      testsRun: { path: "", status: "missing", complete: false, items: [] },
      changedPaths: { path: "", status: "missing", complete: false, items: [] },
      knownRisks: { path: "", status: "missing", complete: false, items: [] },
      warnings: ["evidence: missing workspace path and metadata pointers"],
    };
  }

  const commandLog = parseCommandLogArtifact(paths.commandLog, context);
  let testsRun = parseTestsRunArtifact(paths.testsRun, context);
  let changedPaths = parseChangedPathsArtifact(paths.changedPaths, context);
  const knownRisks = parseKnownRisksArtifact(paths.knownRisks, context);

  if ((testsRun.status === "missing" || testsRun.status === "corrupt") && commandLog.items.length > 0) {
    const fallbackTests = deriveTestsFromCommandLog(commandLog.items);
    if (fallbackTests.items.length > 0) {
      testsRun = {
        ...testsRun,
        status: "fallback",
        items: fallbackTests.items,
        truncated: fallbackTests.truncated,
        complete: false,
        error: testsRun.error ? `${testsRun.error}; derived from command log` : "derived from command log",
      };
    }
  }

  if (
    (changedPaths.status === "missing" || changedPaths.status === "corrupt") &&
    commandLog.items.length > 0
  ) {
    const fallbackPaths = deriveChangedPathsFromCommandLog(commandLog.items);
    if (fallbackPaths.items.length > 0) {
      changedPaths = {
        ...changedPaths,
        status: "fallback",
        items: fallbackPaths.items,
        truncated: fallbackPaths.truncated,
        complete: false,
        error: changedPaths.error
          ? `${changedPaths.error}; derived from command log`
          : "derived from command log",
      };
    }
  }

  addWarning(warnings, "command-log", commandLog);
  addWarning(warnings, "tests-run", testsRun);
  addWarning(warnings, "changed-paths", changedPaths);
  addWarning(warnings, "known-risks", knownRisks);

  const statuses = [commandLog.status, testsRun.status, changedPaths.status, knownRisks.status];
  const anyCorrupt = statuses.includes("corrupt");
  const anyMissing = statuses.includes("missing");
  const allComplete =
    statuses.every((status) => status === "ok") &&
    commandLog.complete &&
    testsRun.complete &&
    changedPaths.complete &&
    knownRisks.complete;

  const status: WorkerEvidenceParseResult["status"] = anyCorrupt
    ? "corrupt"
    : anyMissing
      ? "missing"
      : allComplete
        ? "complete"
        : "incomplete";

  return {
    schemaVersion: params.metadata[EVIDENCE_METADATA_KEYS.schemaVersion] ?? WORKER_EVIDENCE_SCHEMA_VERSION,
    status,
    commandLog,
    testsRun,
    changedPaths,
    knownRisks,
    warnings,
  };
}
