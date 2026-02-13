import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig } from "@agent-orchestrator/core";
import { exec, gh, getTmuxSessions } from "../lib/shell.js";
import { getSessionDir, readMetadata } from "../lib/metadata.js";

interface ReviewInfo {
  session: string;
  prNumber: string;
  pendingComments: number;
  reviewDecision: string | null;
}

async function checkPRReviews(
  repo: string,
  prNumber: string
): Promise<{ pendingComments: number; reviewDecision: string | null }> {
  // Get review decision
  const decision = await gh([
    "pr",
    "view",
    prNumber,
    "--repo",
    repo,
    "--json",
    "reviewDecision",
    "-q",
    ".reviewDecision",
  ]);

  // Get pending review comments count
  const commentsJson = await gh([
    "api",
    `repos/${repo}/pulls/${prNumber}/comments`,
    "--jq",
    "length",
  ]);

  const pendingComments = commentsJson ? parseInt(commentsJson, 10) : 0;

  return {
    pendingComments: isNaN(pendingComments) ? 0 : pendingComments,
    reviewDecision: decision || null,
  };
}

export function registerReviewCheck(program: Command): void {
  program
    .command("review-check")
    .description(
      "Check PRs for review comments and trigger agents to address them"
    )
    .argument("[project]", "Project ID (checks all if omitted)")
    .option("--dry-run", "Show what would be done without sending messages")
    .action(async (projectId: string | undefined, opts: { dryRun?: boolean }) => {
      const config = loadConfig();
      const allTmux = await getTmuxSessions();
      const projects = projectId
        ? { [projectId]: config.projects[projectId] }
        : config.projects;

      if (projectId && !config.projects[projectId]) {
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const spinner = ora("Checking PRs for review comments...").start();
      const results: ReviewInfo[] = [];

      for (const [pid, project] of Object.entries(projects)) {
        const prefix = project.sessionPrefix || pid;
        const sessionDir = getSessionDir(config.dataDir, pid);
        const projectSessions = allTmux.filter((s) =>
          s.startsWith(`${prefix}-`)
        );

        for (const session of projectSessions) {
          const meta = readMetadata(`${sessionDir}/${session}`);
          if (!meta?.pr) continue;

          const prNum = meta.pr.match(/(\d+)\s*$/)?.[1];
          if (!prNum || !project.repo) continue;

          try {
            const { pendingComments, reviewDecision } = await checkPRReviews(
              project.repo,
              prNum
            );
            if (
              pendingComments > 0 ||
              reviewDecision === "CHANGES_REQUESTED"
            ) {
              results.push({
                session,
                prNumber: prNum,
                pendingComments,
                reviewDecision,
              });
            }
          } catch {
            // Skip PRs we can't access
          }
        }
      }

      spinner.stop();

      if (results.length === 0) {
        console.log(chalk.green("No pending review comments found."));
        return;
      }

      console.log(
        chalk.bold(
          `\nFound ${results.length} session${results.length > 1 ? "s" : ""} with pending reviews:\n`
        )
      );

      for (const result of results) {
        console.log(
          `  ${chalk.green(result.session)}  PR #${result.prNumber}`
        );
        if (result.reviewDecision) {
          console.log(
            `    Decision: ${chalk.yellow(result.reviewDecision)}`
          );
        }
        if (result.pendingComments > 0) {
          console.log(
            `    Comments: ${chalk.yellow(String(result.pendingComments))}`
          );
        }

        if (!opts.dryRun) {
          const message =
            "There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.";
          await exec("tmux", [
            "send-keys",
            "-t",
            result.session,
            message,
            "Enter",
          ]);
          console.log(chalk.green(`    -> Fix prompt sent`));
        } else {
          console.log(chalk.dim(`    (dry run — would send fix prompt)`));
        }
      }
      console.log();
    });
}
