import logger from "../logger.js";
import { SyncProcess } from "../types.js";
import { persistence } from "../persistence.js";
import { getLatestBlockNumber } from "../operations/blockOperations.js";
import { originalProvider_v9 } from "../providers.js";
import { ProbeConfig } from "../constants.js";

/**
 * Probe manager for continuous sync
 * Handles checking for new blocks and updating sync targets
 */
export class ProbeManager {
  private readonly probeIntervalMs: number;
  private readonly maxRetries: number;

  constructor(
    probeIntervalMs: number = ProbeConfig.INTERVAL_MS,
    maxRetries: number = 5,
  ) {
    this.probeIntervalMs = probeIntervalMs;
    this.maxRetries = maxRetries;
  }

  /**
   * Probe for new blocks with exponential backoff retry
   */
  public async probeForNewBlocks(process: SyncProcess): Promise<void> {
    if (!process.isContinuous) {
      logger.debug("Skipping probe - not a continuous sync");
      return;
    }

    let retryCount = 0;
    let lastError: any = null;

    while (retryCount < this.maxRetries) {
      try {
        const latestBlock = await getLatestBlockNumber(originalProvider_v9);

        if (latestBlock > process.syncTo) {
          const oldTarget = process.syncTo;
          const newBlocks = latestBlock - oldTarget;

          // Update in-memory process
          process.syncTo = latestBlock;
          if (process.totalBlocks !== null) {
            process.totalBlocks =
              latestBlock -
              (process.currentBlock - process.processedBlocks) +
              1;
          }

          // Update Redis
          await persistence.updateSyncTarget(process.id, latestBlock);

          logger.info(
            `📈 Sync target updated: ${oldTarget} → ${latestBlock} (${newBlocks} new blocks detected)`,
          );
        } else {
          logger.debug(
            `🔍 Probe: No new blocks (latest: ${latestBlock}, target: ${process.syncTo})`,
          );
        }

        return; // Success
      } catch (error) {
        lastError = error;
        retryCount++;

        if (retryCount < this.maxRetries) {
          const delay = Math.pow(2, retryCount) * 1000;
          logger.warn(
            `⚠️  Probe failed (attempt ${retryCount}/${this.maxRetries}), retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      `❌ Probe failed after ${this.maxRetries} attempts. Last error:`,
      lastError,
    );
    logger.warn(
      "⚠️  Continuing with current target, will retry on next probe cycle",
    );
  }

  /**
   * Create a probe interval for a process
   */
  public createProbeInterval(
    process: SyncProcess,
    onError?: (error: Error) => void,
  ): NodeJS.Timeout {
    logger.info(
      `🔍 Starting probe loop for continuous sync (checks every ${this.probeIntervalMs / 1000}s)`,
    );

    return setInterval(async () => {
      try {
        await this.probeForNewBlocks(process);
      } catch (error) {
        logger.error("❌ Probe loop error:", error);
        if (onError) {
          onError(error as Error);
        }
      }
    }, this.probeIntervalMs);
  }

  /**
   * Get probe interval in milliseconds
   */
  public getProbeInterval(): number {
    return this.probeIntervalMs;
  }
}

// Export default instance
export const probeManager = new ProbeManager();
