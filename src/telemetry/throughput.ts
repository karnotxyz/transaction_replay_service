import { updateThroughput, updateSyncBacklog, updateSyncProgress, updateActiveSyncProcesses } from './metrics.js';
import { SyncProcess } from '../types.js';
import logger from '../logger.js';

/**
 * Throughput tracker for monitoring blocks and transactions per second
 */
export class ThroughputTracker {
  private blocksProcessed: number = 0;
  private transactionsProcessed: number = 0;
  private lastUpdateTime: number = Date.now();
  private readonly updateIntervalMs: number = 10000; // Update every 10 seconds

  /**
   * Record a processed block
   */
  recordBlock(txCount: number = 0): void {
    this.blocksProcessed++;
    this.transactionsProcessed += txCount;
    this.maybeUpdateMetrics();
  }

  /**
   * Record processed transactions
   */
  recordTransactions(count: number): void {
    this.transactionsProcessed += count;
    this.maybeUpdateMetrics();
  }

  /**
   * Update metrics if enough time has passed
   */
  private maybeUpdateMetrics(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastUpdateTime) / 1000;

    if (elapsedSeconds >= this.updateIntervalMs / 1000) {
      const blocksPerSecond = this.blocksProcessed / elapsedSeconds;
      const txsPerSecond = this.transactionsProcessed / elapsedSeconds;

      updateThroughput(blocksPerSecond, txsPerSecond);

      // Reset counters
      this.blocksProcessed = 0;
      this.transactionsProcessed = 0;
      this.lastUpdateTime = now;
    }
  }

  /**
   * Force update metrics immediately
   */
  forceUpdate(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastUpdateTime) / 1000;

    if (elapsedSeconds > 0) {
      const blocksPerSecond = this.blocksProcessed / elapsedSeconds;
      const txsPerSecond = this.transactionsProcessed / elapsedSeconds;

      updateThroughput(blocksPerSecond, txsPerSecond);

      // Reset counters
      this.blocksProcessed = 0;
      this.transactionsProcessed = 0;
      this.lastUpdateTime = now;
    }
  }
}

/**
 * Update sync progress and backlog metrics
 */
export function updateSyncMetrics(
  process: SyncProcess,
  originalNodeLatestBlock?: number,
  syncingNodeLatestBlock?: number
): void {
  // Calculate progress percentage
  if (process.totalBlocks && process.totalBlocks > 0) {
    const progress = (process.processedBlocks / process.totalBlocks) * 100;
    updateSyncProgress(process.id, Math.min(progress, 100));
  }

  // Calculate backlog if we have latest block numbers
  if (originalNodeLatestBlock && syncingNodeLatestBlock) {
    const backlog = Math.max(0, originalNodeLatestBlock - syncingNodeLatestBlock);
    updateSyncBacklog(backlog);
  }
}

/**
 * Update active sync process count
 */
export function updateActiveSyncProcessCount(
  syncMode: 'sequential' | 'snap_sync',
  isActive: boolean
): void {
  updateActiveSyncProcesses(syncMode, isActive ? 1 : 0);
}

// Export singleton instance for throughput tracking
export const throughputTracker = new ThroughputTracker();
