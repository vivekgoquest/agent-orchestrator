/**
 * PortManager — centralized port allocation for dashboard services.
 *
 * Tracks allocated ports to prevent double-allocation within a process,
 * and discovers available ports dynamically.
 */

import { isPortAvailable } from "../lib/port.js";

export interface ServicePorts {
  /** Next.js dashboard port */
  dashboard: number;
  /** Terminal WebSocket server port (ttyd proxy) */
  terminalWs: number;
  /** Direct terminal WebSocket server port (node-pty) */
  directTerminalWs: number;
}

export class PortManager {
  private allocatedPorts = new Set<number>();

  /**
   * Allocate ports for all dashboard services.
   * Dashboard gets the preferred port (or next available).
   * WebSocket servers get ports near their defaults (3001, 3003).
   */
  async allocateServicePorts(preferredDashboardPort: number): Promise<ServicePorts> {
    const dashboard = await this.findAvailable(preferredDashboardPort);
    const terminalWs = await this.findAvailable(3001);
    const directTerminalWs = await this.findAvailable(3003);

    return { dashboard, terminalWs, directTerminalWs };
  }

  /**
   * Find next available port starting from the preferred port.
   * Skips ports already allocated by this manager.
   */
  async findAvailable(preferred: number, maxAttempts = 10): Promise<number> {
    for (let offset = 0; offset < maxAttempts; offset++) {
      const port = preferred + offset;

      if (this.allocatedPorts.has(port)) {
        continue;
      }

      if (await isPortAvailable(port)) {
        this.allocatedPorts.add(port);
        return port;
      }
    }

    throw new Error(
      `Could not find available port near ${preferred} after ${maxAttempts} attempts`,
    );
  }

  /** Release a previously allocated port */
  release(port: number): void {
    this.allocatedPorts.delete(port);
  }

  /** Release all allocated ports */
  releaseAll(): void {
    this.allocatedPorts.clear();
  }

  /** Get set of currently allocated ports (for testing/debugging) */
  getAllocatedPorts(): ReadonlySet<number> {
    return this.allocatedPorts;
  }
}
