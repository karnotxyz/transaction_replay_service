import { Request, Response } from "express";
import logger from "./logger.js";
import { processTx } from "./transactions/index.js";
import {
  getLatestBlockNumber,
  getLatestBlockNumberWithRetry,
  closeBlock,
  validateTransactionReceipt,
  matchBlockHash,
  setCustomHeader,
  getBlockWithTxsWithRetry,
  MadaraDownError,
  waitForMadaraRecovery,
  getPreConfirmedBlock,
} from "./utils.js";
import { BlockIdentifier, TransactionWithHash, TXN_HASH } from "starknet";
import { start_sync, currentProcess } from "./startSyncing.js";
import { SyncProcess, SyncRequest } from "./types.js";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";

export const syncEndpoint = async (req: Request, res: Response) => {
  try {
    const { endBlock }: { endBlock: BlockIdentifier } = req.body;

    // Validate request
    if (!endBlock && endBlock !== 0) {
      return res.status(400).json({
        error: "Missing required field: endBlock",
      });
    }

    // Call start_sync - it handles all the logic
    const result = await start_sync(endBlock);

    // Handle already complete case
    if (result.alreadyComplete) {
      return res.status(200).json({
        message: result.message,
        alreadyComplete: true,
        syncFrom: result.syncFrom,
        syncTo: result.syncTo,
      });
    }

    // Success - sync started
    return res.status(202).json({
      message: "Sync process started successfully",
      processId: result.processId,
      status: {
        syncFrom: result.syncFrom,
        syncTo: result.syncTo,
        startTxIndex: result.startTxIndex,
        estimatedBlocks: result.estimatedBlocks,
      },
    });
  } catch (error: any) {
    // Handle specific error codes
    if (error.code === "SYNC_IN_PROGRESS") {
      return res.status(409).json({
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
      return res.status(400).json({
        error: error.message,
        code: error.code,
      });
    }

    // Unknown error
    logger.error("Error starting sync process:", error);
    return res.status(500).json({
      error: `Failed to start sync: ${error.message || error}`,
    });
  }
};

// Cancel sync endpoint
export const cancelSync = async (req: Request, res: Response) => {
  try {
    const processId = req.params.processId;
    const { complete_current_block } = req.body;

    // Validate processId
    if (!processId) {
      return res.status(400).json({
        error: "Missing required parameter: processId",
      });
    }

    // Validate complete_current_block
    if (typeof complete_current_block !== "boolean") {
      return res.status(400).json({
        error:
          "Missing or invalid required field: complete_current_block (must be boolean)",
      });
    }

    // Find the process in the running processes map
    const process = currentProcess!;

    if (!process) {
      return res.status(404).json({
        error: "Process not found or not currently running",
        processId,
      });
    }

    // Check if already cancelled or completed
    if (process.status !== "running") {
      return res.status(400).json({
        error: `Process is not running (current status: ${process.status})`,
        processId,
        status: process.status,
      });
    }

    // Set cancellation flags
    process.cancelRequested = true;
    process.completeCurrentBlock = complete_current_block;

    logger.info(
      `🛑 Cancellation requested for process ${processId} (complete_current_block: ${complete_current_block})`,
    );

    // Return success response
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
    logger.error("Error cancelling sync process:", error);
    return res.status(500).json({
      error: `Failed to cancel sync: ${error.message || error}`,
    });
  }
};

// Cancel current sync endpoint (without processId)
export const cancelCurrentSync = async (req: Request, res: Response) => {
  try {
    const { complete_current_block } = req.body;

    // Validate complete_current_block
    if (typeof complete_current_block !== "boolean") {
      return res.status(400).json({
        error:
          "Missing or invalid required field: complete_current_block (must be boolean)",
      });
    }

    // Check if there's a running process
    if (!currentProcess) {
      return res.status(404).json({
        error: "No sync process currently running",
      });
    }

    // Check if already cancelled or completed
    if (currentProcess.status !== "running") {
      return res.status(400).json({
        error: `Process is not running (current status: ${currentProcess.status})`,
        processId: currentProcess.id,
        status: currentProcess.status,
      });
    }

    // Set cancellation flags
    currentProcess.cancelRequested = true;
    currentProcess.completeCurrentBlock = complete_current_block;

    logger.info(
      `🛑 Cancellation requested for current process ${currentProcess.id} (complete_current_block: ${complete_current_block})`,
    );

    // Return success response
    return res.json({
      message: complete_current_block
        ? "Cancellation requested - will complete current block and stop"
        : "Cancellation requested - will stop immediately after current transaction",
      processId: currentProcess.id,
      cancellationMode: complete_current_block
        ? "complete_current_block"
        : "immediate",
      currentBlock: currentProcess.currentBlock,
      currentTxIndex: currentProcess.currentTxIndex,
      note: complete_current_block
        ? "Process will complete all transactions in current block before stopping"
        : "Process will stop after completing current transaction",
      resumeInfo: {
        message:
          "To resume from this point, use these parameters in your next sync request:",
        syncFrom: currentProcess.currentBlock,
        startTxIndex: complete_current_block
          ? 0
          : currentProcess.currentTxIndex,
      },
    });
  } catch (error: any) {
    logger.error("Error cancelling current sync process:", error);
    return res.status(500).json({
      error: `Failed to cancel sync: ${error.message || error}`,
    });
  }
};

/**
 * Handle Madara recovery and resume from correct point
 */
async function handleMadaraRecovery(
  process: SyncProcess,
  currentBlock: number,
): Promise<{ recovered: boolean; needsRestart: boolean }> {
  logger.warn(`🚨 Madara down detected at block ${currentBlock}`);

  // Update process status
  process.status = "recovering";

  // Wait for Madara to recover (max 1 day)
  const recovered = await waitForMadaraRecovery();

  if (!recovered) {
    logger.error(
      `❌ Madara recovery failed - timeout exceeded (24 hours) at block ${currentBlock}`,
    );
    process.status = "failed";
    process.error = "Madara recovery timeout - exceeded 24 hour wait period";
    return { recovered: false, needsRestart: false };
  }

  // Madara recovered - check PRE_CONFIRMED block state
  logger.info(`✅ Madara recovered - checking PRE_CONFIRMED block state...`);

  try {
    const preConfirmedBlock = await getPreConfirmedBlock(syncingProvider_v9);
    const preConfirmedBlockNumber = preConfirmedBlock.block_number!;
    const preConfirmedTxCount = preConfirmedBlock.transactions.length;

    logger.info(
      `📊 PRE_CONFIRMED block: ${preConfirmedBlockNumber}, transactions: ${preConfirmedTxCount}`,
    );

    // The PRE_CONFIRMED block should always be the current block we're syncing
    if (preConfirmedBlockNumber !== currentBlock) {
      logger.error(
        `❌ PRE_CONFIRMED block ${preConfirmedBlockNumber} doesn't match current block ${currentBlock}`,
      );
      process.status = "failed";
      process.error = `PRE_CONFIRMED block mismatch after recovery`;
      return { recovered: false, needsRestart: false };
    }

    if (preConfirmedTxCount === 0) {
      // Empty block - need to restart from beginning (set headers + send txs)
      logger.info(
        `📭 PRE_CONFIRMED block ${currentBlock} is EMPTY - restarting block from beginning`,
      );
      process.currentTxIndex = 0;
      process.status = "running";
      return { recovered: true, needsRestart: true };
    } else {
      // Has transactions - continue from next transaction
      logger.info(
        `📦 PRE_CONFIRMED block ${currentBlock} has ${preConfirmedTxCount} transactions - resuming from tx ${preConfirmedTxCount}`,
      );
      process.currentTxIndex = preConfirmedTxCount;
      process.status = "running";
      return { recovered: true, needsRestart: false };
    }
  } catch (error) {
    logger.error(`❌ Failed to check PRE_CONFIRMED block state:`, error);
    process.status = "failed";
    process.error = `Failed to check PRE_CONFIRMED block state after recovery: ${error}`;
    return { recovered: false, needsRestart: false };
  }
}

// Enhanced sync block with transaction index support and Madara recovery
export async function syncBlock(
  block_no: number,
  process: SyncProcess,
): Promise<{ completed: boolean; needsRestart: boolean }> {
  try {
    const blockWithTxs = await getBlockWithTxsWithRetry(
      originalProvider_v9,
      block_no,
    );

    logger.info(
      `Found ${blockWithTxs.transactions.length} transactions to process in block ${block_no}`,
    );

    const transactionHashes: string[] = [];
    const startIndex =
      block_no === process.syncFrom ? process.currentTxIndex : 0;

    for (let i = startIndex; i < blockWithTxs.transactions.length; i++) {
      // Check for cancellation before each transaction
      if (process.cancelRequested && !process.completeCurrentBlock) {
        process.currentTxIndex = i;
        process.status = "cancelled";
        process.endTime = new Date();
        logger.info(
          `Immediate cancellation detected at block ${block_no}, transaction ${i}. Last processed tx index: ${
            i - 1
          }`,
        );
        return { completed: false, needsRestart: false };
      }

      const tx: TransactionWithHash = blockWithTxs.transactions[i];
      process.currentTxIndex = i;

      logger.info(
        `Processing transaction ${i}/${blockWithTxs.transactions.length - 1} - ${
          tx.transaction_hash
        }`,
      );

      try {
        const tx_hash = await processTx(tx, block_no);

        await new Promise((resolve) => setTimeout(resolve, 100));

        if (i === startIndex) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await validateTransactionReceipt(syncingProvider_v9, tx_hash, {
            useExponentialBackoff: true,
          });
        } else {
          await validateTransactionReceipt(syncingProvider_v9, tx_hash, {
            maxRetries: 2000,
          });
        }

        transactionHashes.push(tx_hash);
        process.currentTxIndex = i;
      } catch (err) {
        // Check if this is a Madara down error
        if (err instanceof MadaraDownError) {
          logger.warn(
            `🚨 Madara down detected during transaction processing at block ${block_no}, tx ${i}`,
          );

          const recoveryResult = await handleMadaraRecovery(process, block_no);

          if (!recoveryResult.recovered) {
            throw new Error(
              `Madara recovery failed at block ${block_no}, tx ${i}`,
            );
          }

          // Return appropriate signal based on recovery decision
          if (recoveryResult.needsRestart) {
            logger.info(
              `🔄 Block ${block_no} needs restart from beginning after Madara recovery`,
            );
            return { completed: false, needsRestart: true };
          } else {
            logger.info(
              `▶️  Continuing block ${block_no} from tx ${process.currentTxIndex} after Madara recovery`,
            );
            return { completed: false, needsRestart: true }; // Still need to restart the loop
          }
        }

        throw err;
      }
    }

    // If we reach here, the block was completed successfully
    logger.info(
      `All transactions processed successfully for block ${block_no}`,
    );
    return { completed: true, needsRestart: false };
  } catch (error) {
    // Check if this is a Madara down error at block level
    if (error instanceof MadaraDownError) {
      logger.warn(
        `🚨 Madara down detected at block level for block ${block_no}`,
      );

      const recoveryResult = await handleMadaraRecovery(process, block_no);

      if (!recoveryResult.recovered) {
        throw new Error(`Madara recovery failed at block ${block_no}`);
      }

      // Return signal to restart block
      return { completed: false, needsRestart: true };
    }

    throw error;
  }
}

// Block validation (unchanged)
export async function validateBlock(currentBlock: number): Promise<void> {
  const maxRetries = 5;
  let retryCount = 0;
  let blockValidated = false;

  while (retryCount <= maxRetries && !blockValidated) {
    try {
      const latestBlockNumber = await getLatestBlockNumber(syncingProvider_v9);
      if (latestBlockNumber + 1 === currentBlock) {
        blockValidated = true;
      } else {
        throw new Error(
          `Sync block ${currentBlock} is not 1 + ${latestBlockNumber}`,
        );
      }
    } catch (error) {
      retryCount++;
      console.warn(
        `Block validation attempt ${retryCount} failed for block ${currentBlock}:`,
        error,
      );

      if (retryCount > maxRetries) {
        throw new Error(
          `Failed to validate block ${currentBlock} after ${
            maxRetries + 1
          } attempts. Latest error: ${error}`,
        );
      }

      const delay = Math.pow(2, retryCount) * 1000;
      console.log(`Retrying block ${currentBlock} validation in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
