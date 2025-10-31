// snapSync.ts - NEW FILE
// Parallel transaction processing for faster block synchronization

import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import logger from "./logger.js";
import { processTx } from "./transactions/index.js";
import {
  getLatestBlockNumber,
  closeBlock,
  validateTransactionReceipt,
  matchBlockHash,
  setCustomHeader,
  getBlockWithTxsWithRetry,
} from "./utils.js";
import { BlockIdentifier, TransactionWithHash, BlockTag } from "starknet";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
import { persistence } from "./persistence.js";
import { validateBlock } from "./syncing.js";

// Track the current snap sync process
export let currentSnapSyncProcess: SnapSyncProcess | null = null;

interface SnapSyncProcess {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed";
  currentBlock: number;
  endBlock: number;
  totalBlocks: number;
  processedBlocks: number;
  startTime: Date;
  endTime?: Date;
  cancelRequested: boolean;
  error?: string;
}

interface TransactionResult {
  txHash: string;
  success: boolean;
  error?: string;
}

/**
 * Snap Sync Endpoint Handler
 * Accepts a request to sync blocks with parallel transaction processing
 */
export const snapSyncEndpoint = async (req: Request, res: Response) => {
  try {
    const { endBlock }: { endBlock: BlockIdentifier } = req.body;

    // Validate request
    if (!endBlock && endBlock !== 0) {
      return res.status(400).json({
        error: "Missing required field: endBlock",
      });
    }

    // Check if snap sync is already running
    if (currentSnapSyncProcess && currentSnapSyncProcess.status === "running") {
      return res.status(409).json({
        error: "Snap sync already in progress",
        processId: currentSnapSyncProcess.id,
        currentBlock: currentSnapSyncProcess.currentBlock,
        endBlock: currentSnapSyncProcess.endBlock,
      });
    }

    // Determine the target block
    const targetBlock = await getTargetBlock(endBlock);

    // Get current syncing node state
    const syncingNodeLatestBlock =
      await getLatestBlockNumber(syncingProvider_v9);
    const startBlock = syncingNodeLatestBlock + 1;

    // Validate range
    if (startBlock > targetBlock) {
      return res.status(200).json({
        message: "Syncing node is already at or beyond target block",
        alreadyComplete: true,
        currentBlock: syncingNodeLatestBlock,
        targetBlock: targetBlock,
      });
    }

    // Create new snap sync process
    const processId = uuidv4();
    const newProcess: SnapSyncProcess = {
      id: processId,
      status: "running",
      currentBlock: startBlock,
      endBlock: targetBlock,
      totalBlocks: targetBlock - startBlock + 1,
      processedBlocks: 0,
      startTime: new Date(),
      cancelRequested: false,
    };

    currentSnapSyncProcess = newProcess;

    // Save to Redis
    await persistence.saveSyncProcess(processId, startBlock, targetBlock);

    logger.info(`🚀 Starting SNAP SYNC process ${processId}`);
    logger.info(
      `📊 Range: Block ${startBlock} → ${targetBlock} (${newProcess.totalBlocks} blocks)`,
    );
    logger.info(`⚡ Mode: PARALLEL transaction processing`);

    // Start snap sync asynchronously
    snapSyncBlocksAsync(newProcess).catch(async (error) => {
      logger.error(`❌ Snap sync process ${processId} failed:`, error);
      currentSnapSyncProcess = null;
      try {
        await persistence.updateStatus(processId, "failed");
      } catch (err) {
        logger.error(`Failed to update Redis status: ${err}`);
      }
    });

    // Return immediate response
    return res.status(202).json({
      message: "Snap sync process started successfully",
      processId,
      mode: "parallel",
      status: {
        startBlock,
        endBlock: targetBlock,
        totalBlocks: newProcess.totalBlocks,
      },
      note: "Transactions within each block will be processed in parallel for faster synchronization",
    });
  } catch (error: any) {
    logger.error("Error starting snap sync process:", error);
    return res.status(500).json({
      error: `Failed to start snap sync: ${error.message || error}`,
    });
  }
};

/**
 * Get the target block number from BlockIdentifier
 */
async function getTargetBlock(endBlock: BlockIdentifier): Promise<number> {
  if (typeof endBlock === "number") {
    return endBlock;
  }

  if (endBlock === BlockTag.LATEST || endBlock === "latest") {
    const latestBlock = await getLatestBlockNumber(originalProvider_v9);
    return latestBlock;
  }

  if (typeof endBlock === "string") {
    // Try to parse as hex or decimal
    const parsed = endBlock.startsWith("0x")
      ? parseInt(endBlock, 16)
      : parseInt(endBlock, 10);

    if (isNaN(parsed)) {
      throw new Error(`Invalid block identifier: ${endBlock}`);
    }
    return parsed;
  }

  throw new Error(`Unsupported endBlock type: ${typeof endBlock}`);
}

/**
 * Process a single block with PARALLEL transaction processing
 * This is the key difference from regular sync - all transactions are sent at once
 */
async function snapSyncBlock(
  blockNumber: number,
  process: SnapSyncProcess,
): Promise<void> {
  // Get block with all transactions
  const blockWithTxs = await getBlockWithTxsWithRetry(
    originalProvider_v9,
    blockNumber,
  );

  const transactions = blockWithTxs.transactions;
  logger.info(
    `📦 Block ${blockNumber}: Found ${transactions.length} transactions`,
  );

  if (transactions.length === 0) {
    logger.info(`⏭️  Block ${blockNumber} has no transactions, skipping...`);
    return;
  }

  // ⚡ PARALLEL PROCESSING - Send all transactions at once
  logger.info(`⚡ Sending ${transactions.length} transactions in PARALLEL...`);

  const startTime = Date.now();

  // Send all transactions in parallel
  const sendPromises = transactions.map(async (tx, index) => {
    try {
      const txWithHash = tx as TransactionWithHash;
      const txHash = txWithHash.transaction_hash;

      logger.debug(
        `  📤 [${index + 1}/${transactions.length}] Sending tx: ${txHash}`,
      );

      // Process the transaction (send it to syncing node)
      await processTx(txWithHash, blockNumber);

      return {
        txHash,
        success: true,
      } as TransactionResult;
    } catch (error: any) {
      logger.error(
        `  ❌ Failed to send transaction ${index + 1}:`,
        error.message,
      );
      return {
        txHash: (tx as TransactionWithHash).transaction_hash,
        success: false,
        error: error.message,
      } as TransactionResult;
    }
  });

  // Wait for ALL transactions to be sent
  const sendResults = await Promise.allSettled(sendPromises);

  const sendDuration = Date.now() - startTime;
  logger.info(`✅ All transactions sent in ${sendDuration}ms`);

  // Check for failures
  const failedSends = sendResults.filter(
    (result) => result.status === "rejected",
  );
  if (failedSends.length > 0) {
    throw new Error(
      `Failed to send ${failedSends.length}/${transactions.length} transactions in block ${blockNumber}`,
    );
  }

  // Get successful results
  const txResults = sendResults
    .filter((result) => result.status === "fulfilled")
    .map(
      (result) => (result as PromiseFulfilledResult<TransactionResult>).value,
    );

  const failedTxs = txResults.filter((r) => !r.success);
  if (failedTxs.length > 0) {
    throw new Error(
      `${failedTxs.length}/${transactions.length} transactions failed to send in block ${blockNumber}`,
    );
  }

  // ⚡ PARALLEL RECEIPT VALIDATION - Wait for all receipts at once
  logger.info(`⚡ Waiting for ${transactions.length} receipts in PARALLEL...`);

  const receiptStartTime = Date.now();

  const receiptPromises = txResults.map(async (result) => {
    try {
      await validateTransactionReceipt(syncingProvider_v9, result.txHash, {
        maxRetries: 20,
        useExponentialBackoff: false,
        fixedDelay: 100,
      });
      return { txHash: result.txHash, success: true };
    } catch (error: any) {
      logger.error(
        `  ❌ Receipt validation failed for ${result.txHash}:`,
        error.message,
      );
      return { txHash: result.txHash, success: false, error: error.message };
    }
  });

  // Wait for ALL receipts
  const receiptResults = await Promise.allSettled(receiptPromises);

  const receiptDuration = Date.now() - receiptStartTime;
  logger.info(`✅ All receipts validated in ${receiptDuration}ms`);

  // Check receipt validation results
  const failedReceipts = receiptResults.filter(
    (result) => result.status === "rejected",
  );

  if (failedReceipts.length > 0) {
    throw new Error(
      `Failed to validate ${failedReceipts.length}/${transactions.length} receipts in block ${blockNumber}`,
    );
  }

  const totalDuration = Date.now() - startTime;
  logger.info(
    `⚡ Block ${blockNumber} completed in ${totalDuration}ms (${transactions.length} txs in parallel)`,
  );
}

/**
 * Async function to process blocks sequentially, but transactions in parallel
 */
async function snapSyncBlocksAsync(process: SnapSyncProcess): Promise<void> {
  try {
    logger.info(
      `Starting snap sync from block ${process.currentBlock} to ${process.endBlock}`,
    );

    let currentBlock = process.currentBlock;

    while (currentBlock <= process.endBlock) {
      // Check for cancellation
      if (process.cancelRequested) {
        await persistence.updateStatus(process.id, "cancelled");
        currentSnapSyncProcess = null;
        logger.info(
          `🛑 Snap sync process ${process.id} cancelled at block ${currentBlock}`,
        );
        return;
      }

      process.currentBlock = currentBlock;
      logger.info(
        `\n⚡ SNAP SYNCING Block ${currentBlock}`,
      );

      try {
        // Validate block order
        await validateBlock(currentBlock);

        // Set custom headers for the block
        await setCustomHeader(currentBlock);

        // Process block with PARALLEL transaction processing
        await snapSyncBlock(currentBlock, process);

        // Close the block
        await closeBlock();

        // Verify block hash matches
        await matchBlockHash(currentBlock);

        process.processedBlocks++;

        // Update Redis timestamp
        await persistence.updateLastChecked(process.id);

        const percentComplete = (
          (process.processedBlocks / process.totalBlocks) *
          100
        ).toFixed(2);
        logger.info(
          `✅ Block ${currentBlock} completed (${process.processedBlocks}/${process.totalBlocks} - ${percentComplete}%)`,
        );

        // Move to next block
        currentBlock++;
      } catch (error) {
        await persistence.updateStatus(process.id, "failed");
        logger.error(`❌ Failed to process block ${currentBlock}:`, error);
        throw error;
      }
    }

    // Snap sync completed successfully
    process.status = "completed";
    process.endTime = new Date();
    await persistence.updateStatus(process.id, "completed");
    currentSnapSyncProcess = null;

    const duration = process.endTime.getTime() - process.startTime.getTime();
    const durationSeconds = (duration / 1000).toFixed(2);

    logger.info(`\n🎉 SNAP SYNC COMPLETED!`);
    logger.info(`✅ Process ${process.id} finished successfully`);
    logger.info(
      `📊 Processed ${process.processedBlocks} blocks in ${durationSeconds}s`,
    );
    logger.info(
      `📍 Range: ${process.currentBlock - process.processedBlocks + 1} → ${process.currentBlock - 1}`,
    );
  } catch (error) {
    process.status = "failed";
    process.error = error instanceof Error ? error.message : String(error);
    await persistence.updateStatus(process.id, "failed");
    currentSnapSyncProcess = null;
    logger.error(`❌ Snap sync process ${process.id} failed:`, error);
    throw error;
  }
}

/**
 * Cancel the current snap sync process
 */
export const cancelSnapSync = async (req: Request, res: Response) => {
  try {
    if (!currentSnapSyncProcess) {
      return res.status(404).json({
        error: "No snap sync process currently running",
      });
    }

    if (currentSnapSyncProcess.status !== "running") {
      return res.status(400).json({
        error: `Snap sync process is not running (current status: ${currentSnapSyncProcess.status})`,
        processId: currentSnapSyncProcess.id,
        status: currentSnapSyncProcess.status,
      });
    }

    // Set cancellation flag
    currentSnapSyncProcess.cancelRequested = true;

    logger.info(
      `🛑 Cancellation requested for snap sync process ${currentSnapSyncProcess.id}`,
    );

    return res.json({
      message:
        "Snap sync cancellation requested - will stop after current block completes",
      processId: currentSnapSyncProcess.id,
      currentBlock: currentSnapSyncProcess.currentBlock,
      note: "Current block will complete all transactions before stopping",
    });
  } catch (error: any) {
    logger.error("Error cancelling snap sync process:", error);
    return res.status(500).json({
      error: `Failed to cancel snap sync: ${error.message || error}`,
    });
  }
};

/**
 * Get snap sync status
 */
export const getSnapSyncStatus = async (req: Request, res: Response) => {
  try {
    if (!currentSnapSyncProcess) {
      return res.json({
        message: "No snap sync process currently running",
      });
    }

    const percentComplete =
      currentSnapSyncProcess.totalBlocks > 0
        ? (
            (currentSnapSyncProcess.processedBlocks /
              currentSnapSyncProcess.totalBlocks) *
            100
          ).toFixed(2)
        : "0.00";

    const runningFor = currentSnapSyncProcess.endTime
      ? currentSnapSyncProcess.endTime.getTime() -
        currentSnapSyncProcess.startTime.getTime()
      : Date.now() - currentSnapSyncProcess.startTime.getTime();

    return res.json({
      processId: currentSnapSyncProcess.id,
      status: currentSnapSyncProcess.status,
      mode: "parallel",
      progress: {
        currentBlock: currentSnapSyncProcess.currentBlock,
        endBlock: currentSnapSyncProcess.endBlock,
        processedBlocks: currentSnapSyncProcess.processedBlocks,
        totalBlocks: currentSnapSyncProcess.totalBlocks,
        percentComplete: `${percentComplete}%`,
      },
      timing: {
        startTime: currentSnapSyncProcess.startTime,
        endTime: currentSnapSyncProcess.endTime,
        runningFor: `${(runningFor / 1000).toFixed(2)}s`,
      },
      error: currentSnapSyncProcess.error,
    });
  } catch (error: any) {
    logger.error("Error getting snap sync status:", error);
    return res.status(500).json({
      error: `Failed to get snap sync status: ${error.message || error}`,
    });
  }
};
