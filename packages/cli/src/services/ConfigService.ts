/**
 * ConfigService — singleton that loads config once and caches both
 * the config object and the resolved file path.
 *
 * Eliminates repeated findConfigFile() + loadConfig() calls across commands.
 */

import { loadConfig, findConfigFile, type OrchestratorConfig } from "@composio/ao-core";

let cachedConfig: OrchestratorConfig | undefined;
let cachedConfigPath: string | null | undefined;

/**
 * Get the loaded config, loading it on first call.
 * Subsequent calls return the cached instance.
 */
export function getConfig(explicitPath?: string): OrchestratorConfig {
  if (cachedConfig && !explicitPath) {
    return cachedConfig;
  }

  const path = explicitPath ?? findConfigFile() ?? undefined;
  cachedConfig = loadConfig(path);
  cachedConfigPath = cachedConfig.configPath ?? path ?? null;
  return cachedConfig;
}

/**
 * Get the resolved config file path.
 * Returns null if no config has been loaded yet or no file was found.
 */
export function getConfigPath(): string | null {
  if (cachedConfigPath !== undefined) {
    return cachedConfigPath;
  }

  // Trigger config load to discover the path
  const path = findConfigFile();
  cachedConfigPath = path;
  return path;
}

/**
 * Clear the cached config, forcing a fresh load on next getConfig() call.
 * Useful for testing or when config file has changed.
 */
export function reloadConfig(): void {
  cachedConfig = undefined;
  cachedConfigPath = undefined;
}
