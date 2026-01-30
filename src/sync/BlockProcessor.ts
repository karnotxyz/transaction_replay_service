import logger from "../logger.js";
import { SyncProcess } from "../types.js";
import { originalProvider_v9, syncingProvider_v9 } from "../providers.js";
import {
  setCustomHeader,
  closeBlock,
  matchBlockHash,
  getBlockWithTxs,
  getPreConfirmedBlock,
  getLatestBlockNumber,
} from "../operations/blockOperations.js";
import { validateBlock } from "../validation/index.js";
import { executeWithMadaraRecovery } from "../madara/index.js";
import { ProcessStatus } from "../constants.js";
import { MadaraDownError } from "../errors/index.js";
import {
  recordBlockProcessingDuration,
  startTimer,
} from "../telemetry/metrics.js";

/**
 * Result of block processing operations
 */
export interface BlockProcessResult {
  success: boolean;
  needsRestart?: boolean;
  error?: Error;
}

/**
 * Recovery action to take after Madara comes back up
 */
export type RecoveryAction =
  | { type: "restart_block"; blockNumber: number }
  | { type: "continue_block"; blockNumber: number; existingTxHashes: string[] }
  | { type: "skip_to_block"; blockNumber: number }
  | { type: "failed"; error: string };

/**
 * Common block processing operations shared between sequential and snap sync
 */
export class BlockProcessor {
  /**
   * Validate that block is ready to be synced
   */
  async validateBlockReady(
    blockNumber: number,
    process: SyncProcess,
  ): Promise<BlockProcessResult> {
    const endTimer = startTimer();
    try {
      await executeWithMadaraRecovery(
        () => validateBlock(blockNumber),
        `validate block ${blockNumber}`,
        () => {
          process.status = ProcessStatus.RECOVERING;
        },
        () => {
          process.status = ProcessStatus.RUNNING;
        },
        () => {
          process.status = ProcessStatus.FAILED;
        },
      );

      recordBlockProcessingDuration("validate", endTimer());
      return { success: true };
    } catch (error) {
      logger.error(`Failed to validate block ${blockNumber}:`, error);
      return { success: false, error: error as Error };
    }
  }

  /**
   * Set custom headers for a block
   */
  async setBlockHeaders(
    blockNumber: number,
    process: SyncProcess,
  ): Promise<BlockProcessResult> {
    try {
      await executeWithMadaraRecovery(
        () => setCustomHeader(blockNumber),
        `set headers for block ${blockNumber}`,
        () => {
          process.status = ProcessStatus.RECOVERING;
        },
        async () => {
          process.status = ProcessStatus.RUNNING;

          // Check PRE_CONFIRMED state after recovery
          const preConfirmedBlock =
            await getPreConfirmedBlock(syncingProvider_v9);
          if (preConfirmedBlock.transactions.length > 0) {
            logger.info(
              `⚠️  Block ${blockNumber} has ${preConfirmedBlock.transactions.length} txs in PRE_CONFIRMED after recovery`,
            );
          }
        },
        () => {
          process.status = ProcessStatus.FAILED;
        },
      );

      return { success: true };
    } catch (error) {
      logger.error(`Failed to set headers for block ${blockNumber}:`, error);
      return { success: false, error: error as Error };
    }
  }

  /**
   * Validate that all sent transactions are in Madara's PRE_CONFIRMED block before closing
   * This ensures Madara has actually processed all transactions before we call closeBlock
   */
  async validateTransactionsBeforeClose(
    blockNumber: number,
    expectedTxHashes: string[],
    process: SyncProcess,
    maxRetries: number = 500,
    retryDelayMs: number = 200,
  ): Promise<BlockProcessResult> {
    if (expectedTxHashes.length === 0) {
      logger.info(`⏭️ No transactions to validate for block ${blockNumber}`);
      return { success: true };
    }

    logger.info(
      `🔍 Validating ${expectedTxHashes.length} transactions are in PRE_CONFIRMED block before close...`,
    );

    const expectedSet = new Set(expectedTxHashes);
    let attempt = 0;

    while (attempt < maxRetries) {
      attempt++;

      try {
        const preConfirmedBlock = await getPreConfirmedBlock(syncingProvider_v9);
        const preConfirmedBlockNumber = preConfirmedBlock.block_number;
        const pendingTxHashes = (preConfirmedBlock.transactions || []) as string[];

        // Verify we're looking at the right block
        if (preConfirmedBlockNumber !== blockNumber) {
          logger.warn(
            `⚠️ PRE_CONFIRMED block is ${preConfirmedBlockNumber}, expected ${blockNumber}`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }

        // Check which transactions are missing
        const missingTxHashes = expectedTxHashes.filter(
          (txHash) => !pendingTxHashes.includes(txHash),
        );

        if (missingTxHashes.length === 0) {
          logger.info(
            `✅ All ${expectedTxHashes.length} transactions confirmed in PRE_CONFIRMED block ${blockNumber}`,
          );
          return { success: true };
        }

        logger.debug(
          `⏳ Attempt ${attempt}/${maxRetries}: ${missingTxHashes.length}/${expectedTxHashes.length} transactions still missing`,
        );

        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      } catch (error) {
        if (error instanceof MadaraDownError) {
          throw error; // Propagate for recovery handling
        }
        logger.warn(
          `⚠️ Error checking PRE_CONFIRMED block (attempt ${attempt}/${maxRetries}): ${error}`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    const errorMsg = `Failed to validate all transactions in PRE_CONFIRMED block ${blockNumber} after ${maxRetries} attempts`;
    logger.error(errorMsg);
    return { success: false, error: new Error(errorMsg) };
  }

  /**
   * Close a block
   */
  async closeCurrentBlock(
    blockNumber: number,
    process: SyncProcess,
  ): Promise<BlockProcessResult> {
    try {
      await executeWithMadaraRecovery(
        () => closeBlock(),
        `close block ${blockNumber}`,
        () => {
          process.status = ProcessStatus.RECOVERING;
        },
        () => {
          process.status = ProcessStatus.RUNNING;
        },
        () => {
          process.status = ProcessStatus.FAILED;
        },
      );

      return { success: true };
    } catch (error) {
      logger.error(`Failed to close block ${blockNumber}:`, error);
      return { success: false, error: error as Error };
    }
  }

  /**
   * Verify block hash matches between nodes
   */
  async verifyBlockHash(
    blockNumber: number,
    process: SyncProcess,
  ): Promise<BlockProcessResult> {
    try {
      await executeWithMadaraRecovery(
        () => matchBlockHash(blockNumber),
        `verify block hash for ${blockNumber}`,
        () => {
          process.status = ProcessStatus.RECOVERING;
        },
        () => {
          process.status = ProcessStatus.RUNNING;
        },
        () => {
          process.status = ProcessStatus.FAILED;
        },
      );

      logger.info(`✅ Block hash verified for block ${blockNumber}`);
      return { success: true };
    } catch (error) {
      logger.error(`Failed to verify block hash for ${blockNumber}:`, error);
      return { success: false, error: error as Error };
    }
  }

  // NOTE: processBlockLifecycle() method removed - it was never called.
  // Block processing metrics are now tracked directly in snapSync.ts where blocks are actually processed.

  /**
   * Query Madara's actual state and determine what action to take
   * This is STATELESS - we don't assume anything about what we were doing before
   *
   * Possible states after Madara recovery:
   * 1. Madara is at block N-1 (completed), PRE_CONFIRMED is empty → restart block N
   * 2. Madara is at block N-1 (completed), PRE_CONFIRMED has some txs → continue block N with remaining txs
   * 3. Madara is at block N (completed) → skip to block N+1
   * 4. Madara is at block < N-1 → skip to Madara's latest + 1
   */
  async queryMadaraState(targetBlockNumber: number): Promise<RecoveryAction> {
    try {
      // Get Madara's latest completed block
      const latestBlock = await getLatestBlockNumber(syncingProvider_v9);
      logger.info(`📊 Madara latest completed block: ${latestBlock}`);

      // Get PRE_CONFIRMED block state
      const preConfirmedBlock = await getPreConfirmedBlock(syncingProvider_v9);
      const preConfirmedBlockNumber = preConfirmedBlock.block_number;
      const preConfirmedTxHashes = (preConfirmedBlock.transactions || []) as string[];

      logger.info(
        `📊 PRE_CONFIRMED block: ${preConfirmedBlockNumber}, transactions: ${preConfirmedTxHashes.length}`,
      );

      // Case 1: Madara has already completed the target block
      if (latestBlock >= targetBlockNumber) {
        logger.info(
          `✅ Madara already at block ${latestBlock} >= target ${targetBlockNumber}, skipping to next`,
        );
        return { type: "skip_to_block", blockNumber: latestBlock + 1 };
      }

      // Case 2: Madara is behind where we expected (e.g., restarted from earlier state)
      if (latestBlock < targetBlockNumber - 1) {
        logger.info(
          `⚠️ Madara is at block ${latestBlock}, behind expected ${targetBlockNumber - 1}. Continuing from ${latestBlock + 1}`,
        );
        return { type: "skip_to_block", blockNumber: latestBlock + 1 };
      }

      // Case 3: Madara is at targetBlockNumber - 1, check PRE_CONFIRMED state
      if (preConfirmedBlockNumber !== targetBlockNumber) {
        // PRE_CONFIRMED doesn't match - this means we need to start fresh
        logger.info(
          `📭 PRE_CONFIRMED block ${preConfirmedBlockNumber} doesn't match target ${targetBlockNumber}, restarting block`,
        );
        return { type: "restart_block", blockNumber: latestBlock + 1 };
      }

      // PRE_CONFIRMED matches target block
      if (preConfirmedTxHashes.length === 0) {
        // Empty pending block - restart (headers may need to be set)
        logger.info(
          `📭 PRE_CONFIRMED block ${targetBlockNumber} is empty, restarting block`,
        );
        return { type: "restart_block", blockNumber: targetBlockNumber };
      }

      // Has some transactions - continue with remaining
      logger.info(
        `📦 PRE_CONFIRMED block ${targetBlockNumber} has ${preConfirmedTxHashes.length} transactions, will send remaining`,
      );
      return {
        type: "continue_block",
        blockNumber: targetBlockNumber,
        existingTxHashes: preConfirmedTxHashes,
      };
    } catch (error) {
      logger.error(`❌ Failed to query Madara state:`, error);
      return {
        type: "failed",
        error: `Failed to query Madara state: ${error}`,
      };
    }
  }

  /**
   * Handle Madara recovery for a block - STATELESS approach
   * Waits for Madara to come back, then queries its actual state
   */
  async handleBlockRecovery(
    blockNumber: number,
    process: SyncProcess,
  ): Promise<{
    recovered: boolean;
    action: RecoveryAction;
  }> {
    logger.warn(`🚨 Madara down detected at block ${blockNumber}`);

    process.status = ProcessStatus.RECOVERING;

    const { waitForMadaraRecovery } = await import("../madara/index.js");
    const recovered = await waitForMadaraRecovery();

    if (!recovered) {
      logger.error(
        `❌ Madara recovery failed - timeout exceeded (24 hours) at block ${blockNumber}`,
      );
      process.status = ProcessStatus.FAILED;
      process.error = "Madara recovery timeout - exceeded 24 hour wait period";
      return {
        recovered: false,
        action: { type: "failed", error: "Madara recovery timeout" },
      };
    }

    logger.info(`✅ Madara recovered - querying actual state...`);

    // Query Madara's actual state - STATELESS
    const action = await this.queryMadaraState(blockNumber);

    if (action.type === "failed") {
      process.status = ProcessStatus.FAILED;
      process.error = action.error;
      return { recovered: false, action };
    }

    process.status = ProcessStatus.RUNNING;
    return { recovered: true, action };
  }
}

// Export singleton instance
export const blockProcessor = new BlockProcessor();
