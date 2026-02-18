import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Retrospective } from "../retrospective.js";
import { saveRetrospective, loadRetrospectives } from "../retrospective.js";

let tmpDir: string;
let retroDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-retrospective-${randomUUID()}`);
  retroDir = join(tmpDir, "retrospectives");
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to build a Retrospective object with sensible defaults. */
function makeRetro(overrides: Partial<Retrospective> = {}): Retrospective {
  return {
    sessionId: "test-1",
    projectId: "my-project",
    generatedAt: "2025-06-01T12:00:00.000Z",
    outcome: "success",
    timeline: [
      { event: "info", at: "2025-06-01T10:00:00.000Z", detail: "session started" },
      { event: "info", at: "2025-06-01T12:00:00.000Z", detail: "session merged" },
    ],
    metrics: {
      totalDurationMs: 7_200_000,
      ciFailures: 0,
      reviewRounds: 0,
    },
    lessons: ["Clean execution: merged quickly with minimal CI/review iterations."],
    reportCard: {
      sessionId: "test-1",
      projectId: "my-project",
      duration: {
        startedAt: "2025-06-01T10:00:00.000Z",
        endedAt: "2025-06-01T12:00:00.000Z",
        totalMs: 7_200_000,
      },
      stateTransitions: [],
      ciAttempts: 0,
      reviewRounds: 0,
      outcome: "merged",
      prUrl: null,
    },
    ...overrides,
  };
}

describe("saveRetrospective", () => {
  it("creates the directory and writes a JSON file", () => {
    const retro = makeRetro();

    saveRetrospective(retro, retroDir);

    const files = readdirSync(retroDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^test-1-.*\.json$/);

    const content = readFileSync(join(retroDir, files[0]), "utf-8");
    const parsed = JSON.parse(content) as Retrospective;
    expect(parsed.sessionId).toBe("test-1");
    expect(parsed.projectId).toBe("my-project");
    expect(parsed.outcome).toBe("success");
  });

  it("writes to existing directory without error", () => {
    mkdirSync(retroDir, { recursive: true });
    const retro = makeRetro();

    expect(() => saveRetrospective(retro, retroDir)).not.toThrow();

    const files = readdirSync(retroDir);
    expect(files).toHaveLength(1);
  });

  it("writes multiple retrospectives for different sessions", () => {
    saveRetrospective(makeRetro({ sessionId: "test-1" }), retroDir);
    saveRetrospective(makeRetro({ sessionId: "test-2" }), retroDir);
    saveRetrospective(makeRetro({ sessionId: "test-3" }), retroDir);

    const files = readdirSync(retroDir);
    expect(files).toHaveLength(3);
  });

  it("preserves all fields in the written JSON", () => {
    const retro = makeRetro({
      lessons: ["Lesson 1", "Lesson 2"],
      metrics: { totalDurationMs: 100_000, ciFailures: 3, reviewRounds: 2 },
    });

    saveRetrospective(retro, retroDir);

    const files = readdirSync(retroDir);
    const content = readFileSync(join(retroDir, files[0]), "utf-8");
    const parsed = JSON.parse(content) as Retrospective;

    expect(parsed.lessons).toEqual(["Lesson 1", "Lesson 2"]);
    expect(parsed.metrics.ciFailures).toBe(3);
    expect(parsed.metrics.reviewRounds).toBe(2);
    expect(parsed.reportCard).toBeDefined();
  });
});

describe("loadRetrospectives", () => {
  it("returns empty array for non-existent directory", () => {
    const result = loadRetrospectives(join(tmpDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("returns empty array for empty directory", () => {
    mkdirSync(retroDir, { recursive: true });

    const result = loadRetrospectives(retroDir);
    expect(result).toEqual([]);
  });

  it("loads saved retrospectives", () => {
    const retro = makeRetro();
    saveRetrospective(retro, retroDir);

    const results = loadRetrospectives(retroDir);
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("test-1");
    expect(results[0].projectId).toBe("my-project");
    expect(results[0].outcome).toBe("success");
  });

  it("loads multiple retrospectives sorted newest first", () => {
    // Manually write files with controlled names to verify sort order
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "test-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1", generatedAt: "2025-06-01T10:00:00.000Z" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-2-2025-06-02T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-2", generatedAt: "2025-06-02T10:00:00.000Z" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-3-2025-06-03T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-3", generatedAt: "2025-06-03T10:00:00.000Z" })),
      "utf-8",
    );

    const results = loadRetrospectives(retroDir);
    expect(results).toHaveLength(3);
    // Sorted reverse alphabetically by filename, so newest first
    expect(results[0].sessionId).toBe("test-3");
    expect(results[1].sessionId).toBe("test-2");
    expect(results[2].sessionId).toBe("test-1");
  });

  it("filters by sessionId", () => {
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "test-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-2-2025-06-01T11-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-2" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-1-2025-06-02T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1" })),
      "utf-8",
    );

    const results = loadRetrospectives(retroDir, { sessionId: "test-1" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.sessionId === "test-1")).toBe(true);
  });

  it("filters by projectId", () => {
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "test-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1", projectId: "project-a" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-2-2025-06-01T11-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-2", projectId: "project-b" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-3-2025-06-01T12-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-3", projectId: "project-a" })),
      "utf-8",
    );

    const results = loadRetrospectives(retroDir, { projectId: "project-a" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.projectId === "project-a")).toBe(true);
  });

  it("respects limit option", () => {
    mkdirSync(retroDir, { recursive: true });

    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(retroDir, `test-${i}-2025-06-0${i}T10-00-00-000Z.json`),
        JSON.stringify(makeRetro({ sessionId: `test-${i}` })),
        "utf-8",
      );
    }

    const results = loadRetrospectives(retroDir, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("combines sessionId filter with limit", () => {
    mkdirSync(retroDir, { recursive: true });

    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(retroDir, `sess-a-2025-06-0${i}T10-00-00-000Z.json`),
        JSON.stringify(makeRetro({ sessionId: "sess-a" })),
        "utf-8",
      );
    }

    const results = loadRetrospectives(retroDir, { sessionId: "sess-a", limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("skips corrupted JSON files", () => {
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "good-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "good-1" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "bad-1-2025-06-02T10-00-00-000Z.json"),
      "THIS IS NOT VALID JSON {{{",
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "good-2-2025-06-03T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "good-2" })),
      "utf-8",
    );

    const results = loadRetrospectives(retroDir);
    expect(results).toHaveLength(2);
    const sessionIds = results.map((r) => r.sessionId);
    expect(sessionIds).toContain("good-1");
    expect(sessionIds).toContain("good-2");
  });

  it("ignores non-JSON files", () => {
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "test-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1" })),
      "utf-8",
    );
    writeFileSync(join(retroDir, "readme.txt"), "not a retro", "utf-8");
    writeFileSync(join(retroDir, ".hidden"), "hidden file", "utf-8");

    const results = loadRetrospectives(retroDir);
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("test-1");
  });

  it("round-trips save and load", () => {
    const retro = makeRetro({
      sessionId: "roundtrip-1",
      projectId: "proj-x",
      outcome: "failure",
      lessons: ["CI failed 4 times before passing.", "Multiple review rounds (3)."],
      metrics: { totalDurationMs: 50_000_000, ciFailures: 4, reviewRounds: 3 },
    });

    saveRetrospective(retro, retroDir);
    const results = loadRetrospectives(retroDir);

    expect(results).toHaveLength(1);
    const loaded = results[0];
    expect(loaded.sessionId).toBe("roundtrip-1");
    expect(loaded.projectId).toBe("proj-x");
    expect(loaded.outcome).toBe("failure");
    expect(loaded.lessons).toEqual([
      "CI failed 4 times before passing.",
      "Multiple review rounds (3).",
    ]);
    expect(loaded.metrics.ciFailures).toBe(4);
    expect(loaded.metrics.reviewRounds).toBe(3);
    expect(loaded.metrics.totalDurationMs).toBe(50_000_000);
    expect(loaded.reportCard.sessionId).toBe("test-1"); // from default makeRetro
    expect(loaded.timeline).toHaveLength(2);
  });
});
