import { SyncProcess } from "../types.js";
import { persistence } from "../persistence.js";
import logger from "../logger.js";
import { ProcessStatus } from "../constants.js";
import {
  ProcessNotFoundError,
  InvalidProcessStatusError,
} from "../errors/index.js";

/**
 * Singleton state manager for sync processes
 * Provides controlled access to sync process state
 */
export class SyncStateManager {
  private static instance: SyncStateManager;

  // Sequential sync state
  private currentSequentialProcess: SyncProcess | null = null;
  private sequentialProbeInterval: NodeJS.Timeout | null = null;

  // sync state
  private currentSnapSyncProcess: SyncProcess | null = null;
  private snapProbeInterval: NodeJS.Timeout | null = null;

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
  // Sequential Sync Methods
  // ========================================

  /**
   * Get current sequential sync process
   */
  public getSequentialProcess(): SyncProcess | null {
    return this.currentSequentialProcess;
  }

  /**
   * Set current sequential sync process
   */
  public setSequentialProcess(process: SyncProcess | null): void {
    this.currentSequentialProcess = process;

    if (process) {
      logger.info(
        `📝 Sequential sync process registered: ${process.id} (${process.syncFrom} → ${process.syncTo})`,
      );
    } else {
      logger.info("📝 Sequential sync process cleared");
    }
  }

  /**
   * Check if sequential sync is running
   */
  public isSequentialSyncRunning(): boolean {
    return (
      this.currentSequentialProcess !== null &&
      this.currentSequentialProcess.status === ProcessStatus.RUNNING
    );
  }

  /**
   * Update sequential process status
   */
  public async updateSequentialStatus(
    status: (typeof ProcessStatus)[keyof typeof ProcessStatus],
  ): Promise<void> {
    if (!this.currentSequentialProcess) {
      throw new ProcessNotFoundError("No sequential process active");
    }

    this.currentSequentialProcess.status = status;
    await persistence.updateStatus(this.currentSequentialProcess.id, status);
  }

  /**
   * Clear sequential process
   */
  public clearSequentialProcess(): void {
    this.currentSequentialProcess = null;
    this.stopSequentialProbe();
  }

  /**
   * Set sequential probe interval
   */
  public setSequentialProbeInterval(interval: NodeJS.Timeout): void {
    if (this.sequentialProbeInterval) {
      logger.warn(
        "⚠️  Sequential probe already running, clearing old interval",
      );
      clearInterval(this.sequentialProbeInterval);
    }
    this.sequentialProbeInterval = interval;
  }

  /**
   * Stop sequential probe
   */
  public stopSequentialProbe(): void {
    if (this.sequentialProbeInterval) {
      clearInterval(this.sequentialProbeInterval);
      this.sequentialProbeInterval = null;
      logger.info("🛑 Sequential probe loop stopped");
    }
  }

  /**
   * Get sequential probe interval
   */
  public getSequentialProbeInterval(): NodeJS.Timeout | null {
    return this.sequentialProbeInterval;
  }

  // ========================================
  // Sync Methods
  // ========================================

  /**
   * Get current sync process
   */
  public getSnapSyncProcess(): SyncProcess | null {
    return this.currentSnapSyncProcess;
  }

  /**
   * Set current sync process
   */
  public setSnapSyncProcess(process: SyncProcess | null): void {
    this.currentSnapSyncProcess = process;

    if (process) {
      logger.info(
        `📝 sync process registered: ${process.id} (${process.syncFrom} → ${process.syncTo})`,
      );
    } else {
      logger.info("📝 sync process cleared");
    }
  }

  /**
   * Check if sync is running
   */
  public isSnapSyncRunning(): boolean {
    return (
      this.currentSnapSyncProcess !== null &&
      this.currentSnapSyncProcess.status === ProcessStatus.RUNNING
    );
  }

  /**
   * Update sync process status
   */
  public async updateSnapSyncStatus(
    status: (typeof ProcessStatus)[keyof typeof ProcessStatus],
  ): Promise<void> {
    if (!this.currentSnapSyncProcess) {
      throw new ProcessNotFoundError("No sync process active");
    }

    this.currentSnapSyncProcess.status = status;
    await persistence.updateStatus(this.currentSnapSyncProcess.id, status);
  }

  /**
   * Clear sync process
   */
  public clearSnapSyncProcess(): void {
    this.currentSnapSyncProcess = null;
    this.stopSnapProbe();
  }

  /**
   * Set snap probe interval
   */
  public setSnapProbeInterval(interval: NodeJS.Timeout): void {
    if (this.snapProbeInterval) {
      logger.warn("⚠️  Snap probe already running, clearing old interval");
      clearInterval(this.snapProbeInterval);
    }
    this.snapProbeInterval = interval;
  }

  /**
   * Stop snap probe
   */
  public stopSnapProbe(): void {
    if (this.snapProbeInterval) {
      clearInterval(this.snapProbeInterval);
      this.snapProbeInterval = null;
      logger.info("🛑 Snap probe loop stopped");
    }
  }

  /**
   * Get snap probe interval
   */
  public getSnapProbeInterval(): NodeJS.Timeout | null {
    return this.snapProbeInterval;
  }

  // ========================================
  // General Methods
  // ========================================

  /**
   * Check if any sync is running
   */
  public isAnySyncRunning(): boolean {
    return this.isSequentialSyncRunning() || this.isSnapSyncRunning();
  }

  /**
   * Get all active processes
   */
  public getAllActiveProcesses(): SyncProcess[] {
    const processes: SyncProcess[] = [];

    if (this.currentSequentialProcess) {
      processes.push(this.currentSequentialProcess);
    }

    if (this.currentSnapSyncProcess) {
      processes.push(this.currentSnapSyncProcess);
    }

    return processes;
  }

  /**
   * Stop all probes
   */
  public stopAllProbes(): void {
    this.stopSequentialProbe();
    this.stopSnapProbe();
  }

  /**
   * Clear all processes
   */
  public clearAllProcesses(): void {
    this.clearSequentialProcess();
    this.clearSnapSyncProcess();
  }

  /**
   * Graceful shutdown - stop all probes and clear state
   */
  public async shutdown(): Promise<void> {
    logger.info("🛑 Shutting down SyncStateManager...");

    this.stopAllProbes();

    // Update statuses in Redis for any running processes
    const processes = this.getAllActiveProcesses();
    for (const process of processes) {
      if (process.status === ProcessStatus.RUNNING) {
        await persistence.updateStatus(process.id, ProcessStatus.CANCELLED);
      }
    }

    this.clearAllProcesses();

    logger.info("✅ SyncStateManager shutdown complete");
  }
}

// Export singleton instance
export const syncStateManager = SyncStateManager.getInstance();
