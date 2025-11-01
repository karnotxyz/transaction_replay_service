import logger from "../logger.js";
import { SyncProcess } from "../types.js";
import { originalProvider_v9, syncingProvider_v9 } from "../providers.js";
import {
  setCustomHeader,
  closeBlock,
  matchBlockHash,
  getBlockWithTxs,
  getPreConfirmedBlock,
} from "../operations/blockOperations.js";
import { validateBlock } from "../validation/index.js";
import { executeWithMadaraRecovery } from "../madara/index.js";
import { ProcessStatus } from "../constants.js";
import { MadaraDownError } from "../errors/index.js";

/**
 * Result of block processing operations
 */
export interface BlockProcessResult {
  success: boolean;
  needsRestart?: boolean;
  error?: Error;
}

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

  /**
   * Complete sequence of operations to process a block
   * (validate, set headers, process transactions, close, verify)
   */
  async processBlockLifecycle(
    blockNumber: number,
    process: SyncProcess,
    transactionProcessor: () => Promise<BlockProcessResult>,
  ): Promise<BlockProcessResult> {
    // 1. Validate block is ready
    const validateResult = await this.validateBlockReady(blockNumber, process);
    if (!validateResult.success) {
      return validateResult;
    }

    // 2. Set custom headers
    const headersResult = await this.setBlockHeaders(blockNumber, process);
    if (!headersResult.success) {
      return headersResult;
    }

    // 3. Process transactions (delegated to caller)
    const txResult = await transactionProcessor();
    if (!txResult.success) {
      return txResult;
    }

    // 4. Close the block
    const closeResult = await this.closeCurrentBlock(blockNumber, process);
    if (!closeResult.success) {
      return closeResult;
    }

    // 5. Verify block hash
    const verifyResult = await this.verifyBlockHash(blockNumber, process);
    if (!verifyResult.success) {
      return verifyResult;
    }

    return { success: true };
  }

  /**
   * Handle Madara recovery for a block
   * Determines if block needs restart based on PRE_CONFIRMED state
   */
  async handleBlockRecovery(
    blockNumber: number,
    process: SyncProcess,
  ): Promise<{
    recovered: boolean;
    needsRestart: boolean;
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
      return { recovered: false, needsRestart: false };
    }

    logger.info(`✅ Madara recovered - checking PRE_CONFIRMED block state...`);

    try {
      const preConfirmedBlock = await getPreConfirmedBlock(syncingProvider_v9);
      const preConfirmedBlockNumber = preConfirmedBlock.block_number!;
      const preConfirmedTxCount = preConfirmedBlock.transactions.length;

      logger.info(
        `📊 PRE_CONFIRMED block: ${preConfirmedBlockNumber}, transactions: ${preConfirmedTxCount}`,
      );

      if (preConfirmedBlockNumber !== blockNumber) {
        logger.error(
          `❌ PRE_CONFIRMED block ${preConfirmedBlockNumber} doesn't match current block ${blockNumber}`,
        );
        process.status = ProcessStatus.FAILED;
        process.error = `PRE_CONFIRMED block mismatch after recovery`;
        return { recovered: false, needsRestart: false };
      }

      if (preConfirmedTxCount === 0) {
        logger.info(
          `📭 PRE_CONFIRMED block ${blockNumber} is EMPTY - will restart block`,
        );
        process.status = ProcessStatus.RUNNING;
        return { recovered: true, needsRestart: true };
      } else {
        logger.info(
          `📦 PRE_CONFIRMED block ${blockNumber} has ${preConfirmedTxCount} transactions`,
        );
        process.status = ProcessStatus.RUNNING;
        return { recovered: true, needsRestart: true };
      }
    } catch (error) {
      logger.error(`❌ Failed to check PRE_CONFIRMED block state:`, error);
      process.status = ProcessStatus.FAILED;
      process.error = `Failed to check PRE_CONFIRMED block state after recovery: ${error}`;
      return { recovered: false, needsRestart: false };
    }
  }
}

// Export singleton instance
export const blockProcessor = new BlockProcessor();
