import { Request, Response } from "express";
import logger from "./logger.js";
import { processTx } from "./transactions/index.js";
import { validateTransactionReceipt } from "./operations/transactionOperations.js";
import { getBlockWithTxs } from "./operations/blockOperations.js";
import { BlockIdentifier, TransactionWithHash } from "starknet";
import { start_sync } from "./startSyncing.js";
import { SyncProcess } from "./types.js";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
import { syncStateManager } from "./state/index.js";
import { blockProcessor } from "./sync/BlockProcessor.js";
import { MadaraDownError } from "./errors/index.js";
import { HttpStatus, ProcessStatus } from "./constants.js";
import {
  ProcessNotFoundError,
  InvalidProcessStatusError,
} from "./errors/index.js";

/**
 * Sync endpoint handler
 */
export const syncEndpoint = async (req: Request, res: Response) => {
  try {
    const { endBlock }: { endBlock: BlockIdentifier } = req.body;

    if (!endBlock && endBlock !== 0) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: "Missing required field: endBlock",
      });
    }

    const result = await start_sync(endBlock);

    if (result.alreadyComplete) {
      return res.status(HttpStatus.OK).json({
        message: result.message,
        alreadyComplete: true,
        syncFrom: result.syncFrom,
        syncTo: result.syncTo,
      });
    }

    return res.status(HttpStatus.ACCEPTED).json({
      message: "Sync process started successfully",
      processId: result.processId,
      mode: result.isContinuous ? "continuous" : "sequential",
      status: {
        syncFrom: result.syncFrom,
        syncTo: result.syncTo,
        startTxIndex: result.startTxIndex,
        estimatedBlocks: result.estimatedBlocks,
      },
    });
  } catch (error: any) {
    if (error.code === "SYNC_IN_PROGRESS") {
      return res.status(HttpStatus.CONFLICT).json({
        error: error.message,
        ...error.details,
      });
    }

    if (
      error.code === "INVALID_BLOCK_NUMBER" ||
      error.code === "INVALID_BLOCK_IDENTIFIER" ||
      error.code === "INVALID_BLOCK_TYPE" ||
      error.code === "BLOCK_NUMBER_TOO_LARGE"
    ) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: error.message,
        code: error.code,
      });
    }

    logger.error("Error starting sync process:", error);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: `Failed to start sync: ${error.message || error}`,
    });
  }
};

/**
 * Cancel sync endpoint (by processId)
 */
export const cancelSync = async (req: Request, res: Response) => {
  try {
    const processId = req.params.processId;
    const { complete_current_block } = req.body;

    if (!processId) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: "Missing required parameter: processId",
      });
    }

    if (typeof complete_current_block !== "boolean") {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          "Missing or invalid required field: complete_current_block (must be boolean)",
      });
    }

    const process = syncStateManager.getSequentialProcess();

    if (!process || process.id !== processId) {
      throw new ProcessNotFoundError(processId);
    }

    if (process.status !== ProcessStatus.RUNNING) {
      throw new InvalidProcessStatusError(
        processId,
        process.status,
        `Process is not running (current status: ${process.status})`,
      );
    }

    process.cancelRequested = true;
    process.completeCurrentBlock = complete_current_block;

    logger.info(
      `🛑 Cancellation requested for process ${processId} (complete_current_block: ${complete_current_block})`,
    );

    return res.json({
      message: complete_current_block
        ? "Cancellation requested - will complete current block and stop"
        : "Cancellation requested - will stop immediately after current transaction",
      processId: process.id,
      cancellationMode: complete_current_block
        ? "complete_current_block"
        : "immediate",
      currentBlock: process.currentBlock,
      currentTxIndex: process.currentTxIndex,
      note: complete_current_block
        ? "Process will complete all transactions in current block before stopping"
        : "Process will stop after completing current transaction",
      resumeInfo: {
        message:
          "To resume from this point, use these parameters in your next sync request:",
        syncFrom: process.currentBlock,
        startTxIndex: complete_current_block ? 0 : process.currentTxIndex,
      },
    });
  } catch (error: any) {
    if (error instanceof ProcessNotFoundError) {
      return res.status(HttpStatus.NOT_FOUND).json({
        error: error.message,
        code: error.code,
      });
    }

    if (error instanceof InvalidProcessStatusError) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: error.message,
        code: error.code,
        processId: error.processId,
        currentStatus: error.currentStatus,
      });
    }

    logger.error("Error cancelling sync process:", error);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: `Failed to cancel sync: ${error.message || error}`,
    });
  }
};

/**
 * Cancel current sync endpoint
 */
export const cancelCurrentSync = async (req: Request, res: Response) => {
  try {
    const { complete_current_block } = req.body;

    if (typeof complete_current_block !== "boolean") {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          "Missing or invalid required field: complete_current_block (must be boolean)",
      });
    }

    const process = syncStateManager.getSequentialProcess();

    if (!process) {
      return res.status(HttpStatus.NOT_FOUND).json({
        error: "No sync process currently running",
      });
    }

    if (process.status !== ProcessStatus.RUNNING) {
      throw new InvalidProcessStatusError(
        process.id,
        process.status,
        `Process is not running (current status: ${process.status})`,
      );
    }

    process.cancelRequested = true;
    process.completeCurrentBlock = complete_current_block;

    logger.info(
      `🛑 Cancellation requested for current process ${process.id} (complete_current_block: ${complete_current_block})`,
    );

    return res.json({
      message: complete_current_block
        ? "Cancellation requested - will complete current block and stop"
        : "Cancellation requested - will stop immediately after current transaction",
      processId: process.id,
      cancellationMode: complete_current_block
        ? "complete_current_block"
        : "immediate",
      currentBlock: process.currentBlock,
      currentTxIndex: process.currentTxIndex,
      note: complete_current_block
        ? "Process will complete all transactions in current block before stopping"
        : "Process will stop after completing current transaction",
      resumeInfo: {
        message:
          "To resume from this point, use these parameters in your next sync request:",
        syncFrom: process.currentBlock,
        startTxIndex: complete_current_block ? 0 : process.currentTxIndex,
      },
    });
  } catch (error: any) {
    if (error instanceof InvalidProcessStatusError) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: error.message,
        code: error.code,
        processId: error.processId,
        currentStatus: error.currentStatus,
      });
    }

    logger.error("Error cancelling current sync process:", error);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: `Failed to cancel sync: ${error.message || error}`,
    });
  }
};

/**
 * Sync a single block with transaction-level resumability
 */
export async function syncBlock(
  blockNumber: number,
  process: SyncProcess,
): Promise<{ completed: boolean; needsRestart: boolean }> {
  try {
    const blockWithTxs = await getBlockWithTxs(
      originalProvider_v9,
      blockNumber,
    );

    logger.info(
      `Found ${blockWithTxs.transactions.length} transactions to process in block ${blockNumber}`,
    );

    const startIndex =
      blockNumber === process.syncFrom ? process.currentTxIndex : 0;

    for (let i = startIndex; i < blockWithTxs.transactions.length; i++) {
      // Check for cancellation before each transaction
      if (process.cancelRequested && !process.completeCurrentBlock) {
        process.currentTxIndex = i;
        process.status = ProcessStatus.CANCELLED;
        process.endTime = new Date();
        logger.info(
          `Immediate cancellation detected at block ${blockNumber}, transaction ${i}. Last processed tx index: ${i - 1}`,
        );
        return { completed: false, needsRestart: false };
      }

      const tx: TransactionWithHash = blockWithTxs.transactions[i];
      process.currentTxIndex = i;

      logger.info(
        `Processing transaction ${i + 1}/${blockWithTxs.transactions.length} - ${tx.transaction_hash}`,
      );

      try {
        const txHash = await processTx(tx, blockNumber);

        await new Promise((resolve) => setTimeout(resolve, 100));

        if (i === startIndex) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await validateTransactionReceipt(syncingProvider_v9, txHash, {
            useExponentialBackoff: true,
          });
        } else {
          await validateTransactionReceipt(syncingProvider_v9, txHash, {
            maxRetries: 2000,
          });
        }

        process.currentTxIndex = i;
      } catch (err) {
        // Check if this is a Madara down error
        if (err instanceof MadaraDownError) {
          logger.warn(
            `🚨 Madara down detected during transaction processing at block ${blockNumber}, tx ${i}`,
          );

          const recoveryResult = await blockProcessor.handleBlockRecovery(
            blockNumber,
            process,
          );

          if (!recoveryResult.recovered) {
            throw new Error(
              `Madara recovery failed at block ${blockNumber}, tx ${i}`,
            );
          }

          if (recoveryResult.needsRestart) {
            logger.info(
              `🔄 Block ${blockNumber} needs restart from beginning after Madara recovery`,
            );
            return { completed: false, needsRestart: true };
          } else {
            logger.info(
              `▶️  Continuing block ${blockNumber} from tx ${process.currentTxIndex} after Madara recovery`,
            );
            return { completed: false, needsRestart: true };
          }
        }

        throw err;
      }
    }

    logger.info(
      `All transactions processed successfully for block ${blockNumber}`,
    );
    return { completed: true, needsRestart: false };
  } catch (error) {
    if (error instanceof MadaraDownError) {
      logger.warn(
        `🚨 Madara down detected at block level for block ${blockNumber}`,
      );

      const recoveryResult = await blockProcessor.handleBlockRecovery(
        blockNumber,
        process,
      );

      if (!recoveryResult.recovered) {
        throw new Error(`Madara recovery failed at block ${blockNumber}`);
      }

      return { completed: false, needsRestart: true };
    }

    throw error;
  }
}

/**
 * Validate block is ready to be synced
 * (Exported for use in startSyncing.ts)
 */
export async function validateBlock(currentBlock: number): Promise<void> {
  const { validateBlock: validate } = await import("./validation/index.js");
  await validate(currentBlock);
}
