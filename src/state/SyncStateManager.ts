import { SyncProcess } from "../types.js";
import logger from "../logger.js";
import { ProcessStatus } from "../constants.js";
import { ProcessNotFoundError } from "../errors/index.js";

/**
 * Singleton state manager for sync process
 * Provides controlled access to sync process state (in-memory only)
 */
export class SyncStateManager {
  private static instance: SyncStateManager;

  // Sync state
  private currentProcess: SyncProcess | null = null;
  private probeInterval: NodeJS.Timeout | null = null;
  private runPromise: Promise<void> | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  public static getInstance(): SyncStateManager {
    if (!SyncStateManager.instance) {
      SyncStateManager.instance = new SyncStateManager();
    }
    return SyncStateManager.instance;
  }

  // ========================================
  // Sync Methods
  // ========================================

  /**
   * Get current sync process
   */
  public getProcess(): SyncProcess | null {
    return this.currentProcess;
  }

  /**
   * Whether any sync process is currently registered
   */
  public hasActiveProcess(): boolean {
    return this.currentProcess !== null;
  }

  /**
   * Set current sync process
   */
  public setProcess(process: SyncProcess | null): void {
    this.currentProcess = process;

    if (process) {
      logger.info(
        `📝 Sync process registered: ${process.id} (${process.syncFrom} → ${process.syncTo})`,
      );
    } else {
      logger.info("📝 Sync process cleared");
    }
  }

  /**
   * Track the active run promise for cooperative shutdown/reconcile waits
   */
  public setRunPromise(runPromise: Promise<void> | null): void {
    this.runPromise = runPromise;
  }

  /**
   * Wait for the current run promise to finish, if any
   */
  public async waitForRunToFinish(): Promise<void> {
    if (!this.runPromise) {
      return;
    }

    try {
      await this.runPromise;
    } catch {
      // The caller only needs to know the loop stopped.
    }
  }

  /**
   * Check if sync is running
   */
  public isSyncRunning(): boolean {
    return (
      this.currentProcess !== null &&
      this.currentProcess.status === ProcessStatus.RUNNING
    );
  }

  /**
   * Update sync process status
   */
  public updateStatus(
    status: (typeof ProcessStatus)[keyof typeof ProcessStatus],
  ): void {
    if (!this.currentProcess) {
      throw new ProcessNotFoundError("No sync process active");
    }

    this.currentProcess.status = status;
  }

  /**
   * Clear sync process
   */
  public clearProcess(): void {
    this.currentProcess = null;
    this.runPromise = null;
    this.stopProbe();
  }

  /**
   * Request that the current process yields for reconcile at the next phase boundary
   */
  public requestReconcileStop(): boolean {
    if (!this.currentProcess) {
      return false;
    }

    this.currentProcess.reconcileRequested = true;
    this.currentProcess.status = ProcessStatus.RECONCILING;
    logger.info(
      `🛑 Reconcile stop requested for sync process ${this.currentProcess.id}`,
    );
    return true;
  }

  /**
   * Set probe interval
   */
  public setProbeInterval(interval: NodeJS.Timeout): void {
    if (this.probeInterval) {
      logger.warn("⚠️  Probe already running, clearing old interval");
      clearInterval(this.probeInterval);
    }
    this.probeInterval = interval;
  }

  /**
   * Stop probe
   */
  public stopProbe(): void {
    if (this.probeInterval) {
      clearInterval(this.probeInterval);
      this.probeInterval = null;
      logger.info("🛑 Probe loop stopped");
    }
  }

  /**
   * Get probe interval
   */
  public getProbeInterval(): NodeJS.Timeout | null {
    return this.probeInterval;
  }

  /**
   * Graceful shutdown - stop probe and clear state
   */
  public async shutdown(): Promise<void> {
    logger.info("🛑 Shutting down SyncStateManager...");

    this.stopProbe();

    // State file tracks intent, not position
    // On restart, recovery will query syncing node for actual position
    if (this.currentProcess && this.currentProcess.status === ProcessStatus.RUNNING) {
      logger.info(
        `💾 Process ${this.currentProcess.id} state preserved for recovery on restart`,
      );
    }

    this.clearProcess();

    logger.info("✅ SyncStateManager shutdown complete");
  }
}

// Export singleton instance
export const syncStateManager = SyncStateManager.getInstance();
