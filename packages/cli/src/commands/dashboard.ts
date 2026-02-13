import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@agent-orchestrator/core";

/**
 * Locate the @agent-orchestrator/web package directory.
 * We resolve from the package root (two levels up from dist/commands/)
 * using require.resolve-style lookup so it works both in dev and after tsc.
 */
function findWebDir(): string {
  // Try to resolve from node_modules first (installed as workspace dep)
  try {
    const pkgJson = require.resolve("@agent-orchestrator/web/package.json");
    return resolve(pkgJson, "..");
  } catch {
    // Fallback: sibling package in monorepo (works both from src/ and dist/)
    // packages/cli/src/commands/ → packages/web
    // packages/cli/dist/commands/ → packages/web
    const candidates = [
      resolve(__dirname, "../../../web"),
      resolve(__dirname, "../../../../packages/web"),
    ];
    for (const candidate of candidates) {
      if (existsSync(resolve(candidate, "package.json"))) {
        return candidate;
      }
    }
    return candidates[0];
  }
}

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .action(async (opts: { port?: string; open?: boolean }) => {
      const config = loadConfig();
      const port = opts.port ? parseInt(opts.port, 10) : config.port;

      console.log(
        chalk.bold(`Starting dashboard on http://localhost:${port}\n`)
      );

      const webDir = findWebDir();

      if (!existsSync(resolve(webDir, "package.json"))) {
        console.error(
          chalk.red(
            "Could not find @agent-orchestrator/web package.\n" +
            "Ensure it is installed: pnpm install"
          )
        );
        process.exit(1);
      }

      const child = spawn("npx", ["next", "dev", "-p", String(port)], {
        cwd: webDir,
        stdio: "inherit",
      });

      child.on("error", (err) => {
        console.error(
          chalk.red("Could not start dashboard. Ensure Next.js is installed.")
        );
        console.error(chalk.dim(String(err)));
        process.exit(1);
      });

      if (opts.open !== false) {
        setTimeout(() => {
          spawn("open", [`http://localhost:${port}`], {
            stdio: "ignore",
          });
        }, 3000);
      }

      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });
    });
}
