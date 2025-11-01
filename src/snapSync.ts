// snapSync.ts - PARALLEL SYNC WITH CONTINUOUS MODE SUPPORT
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

// 🆕 Probe state management for snap sync
let snapProbeInterval: NodeJS.Timeout | null = null;
const SNAP_PROBE_INTERVAL_MS = 60 * 1000; // 1 minute
const SNAP_PROBE_MAX_RETRIES = 5;

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
  isContinuous?: boolean; // 🆕 continuous sync flag
  originalTarget?: number; // 🆕 initial target for continuous sync
}

interface TransactionResult {
  txHash: string;
  success: boolean;
  error?: string;
}

// 🆕 Start the probe loop for continuous snap sync
function startSnapProbeLoop(process: SnapSyncProcess): void {
  if (snapProbeInterval) {
    logger.warn("⚠️  Snap probe loop already running, skipping start");
    return;
  }

  logger.info(
    "🔍 Starting snap probe loop for continuous sync (checks every 60s)",
  );

  snapProbeInterval = setInterval(async () => {
    try {
      await snapProbeForNewBlocks(process);
    } catch (error) {
      logger.error("❌ Snap probe loop error:", error);
    }
  }, SNAP_PROBE_INTERVAL_MS);
}

// 🆕 Stop the snap probe loop
function stopSnapProbeLoop(): void {
  if (snapProbeInterval) {
    clearInterval(snapProbeInterval);
    snapProbeInterval = null;
    logger.info("🛑 Snap probe loop stopped");
  }
}

// 🆕 Probe function for snap sync with exponential backoff retry
async function snapProbeForNewBlocks(process: SnapSyncProcess): Promise<void> {
  if (!process.isContinuous) {
    logger.debug("Skipping snap probe - not a continuous sync");
    return;
  }

  let retryCount = 0;
  let lastError: any = null;

  while (retryCount < SNAP_PROBE_MAX_RETRIES) {
    try {
      const latestBlock = await getLatestBlockNumber(originalProvider_v9);

      if (latestBlock > process.endBlock) {
        const oldTarget = process.endBlock;
        const newBlocks = latestBlock - oldTarget;

        // Update in-memory process
        process.endBlock = latestBlock;
        process.totalBlocks =
          latestBlock - (process.currentBlock - process.processedBlocks) + 1;

        // Update Redis
        await persistence.updateSyncTarget(process.id, latestBlock);

        logger.info(
          `📈 Snap sync target updated: ${oldTarget} → ${latestBlock} (${newBlocks} new blocks detected)`,
        );
      } else {
        logger.debug(
          `🔍 Snap probe: No new blocks (latest: ${latestBlock}, target: ${process.endBlock})`,
        );
      }

      // Success - exit retry loop
      return;
    } catch (error) {
      lastError = error;
      retryCount++;

      if (retryCount < SNAP_PROBE_MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        const delay = Math.pow(2, retryCount) * 1000;
        logger.warn(
          `⚠️  Snap probe failed (attempt ${retryCount}/${SNAP_PROBE_MAX_RETRIES}), retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries failed
  logger.error(
    `❌ Snap probe failed after ${SNAP_PROBE_MAX_RETRIES} attempts. Last error:`,
    lastError,
  );
  logger.warn(
    "⚠️  Continuing with current target, will retry on next probe cycle",
  );
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
      const response: any = {
        error: "Snap sync already in progress",
        processId: currentSnapSyncProcess.id,
        currentBlock: currentSnapSyncProcess.currentBlock,
        endBlock: currentSnapSyncProcess.endBlock,
      };

      if (currentSnapSyncProcess.isContinuous) {
        response.mode = "continuous";
        response.note =
          "This is a continuous snap sync following the latest blocks";
      }

      return res.status(409).json(response);
    }

    // 🆕 Detect continuous sync mode
    const isContinuous =
      endBlock === BlockTag.LATEST ||
      endBlock === "latest" ||
      endBlock === null;

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
      isContinuous,
      originalTarget: isContinuous ? targetBlock : undefined,
    };

    currentSnapSyncProcess = newProcess;

    // Save to Redis with continuous flag
    await persistence.saveSyncProcess(
      processId,
      startBlock,
      targetBlock,
      isContinuous,
      isContinuous ? targetBlock : undefined,
    );

    const mode = isContinuous ? "CONTINUOUS (following latest)" : "FIXED";
    logger.info(`🚀 Starting SNAP SYNC process ${processId} [${mode}]`);
    logger.info(
      `📊 Range: Block ${startBlock} → ${targetBlock} (${newProcess.totalBlocks} blocks)`,
    );
    logger.info(`⚡ Mode: SEQUENTIAL sending, PARALLEL receipt validation`);

    if (isContinuous) {
      logger.info(
        `🔄 Continuous snap sync enabled - will track new blocks as they arrive`,
      );
      logger.info(`📍 Initial target: block ${targetBlock}`);
      // Start probe loop
      startSnapProbeLoop(newProcess);
    }

    // Start snap sync asynchronously
    snapSyncBlocksAsync(newProcess).catch(async (error) => {
      logger.error(`❌ Snap sync process ${processId} failed:`, error);
      if (newProcess.isContinuous) {
        stopSnapProbeLoop();
      }
      currentSnapSyncProcess = null;
      try {
        await persistence.updateStatus(processId, "failed");
      } catch (err) {
        logger.error(`Failed to update Redis status: ${err}`);
      }
    });

    // Return immediate response
    const response: any = {
      message: "Snap sync process started successfully",
      processId,
      mode: isContinuous
        ? "continuous-parallel"
        : "sequential-send-parallel-receipt",
      status: {
        startBlock,
        endBlock: targetBlock,
        totalBlocks: newProcess.totalBlocks,
      },
      note: "Transactions will be sent sequentially, then all receipts validated in parallel before closing block",
    };

    if (isContinuous) {
      response.continuousSyncNote =
        "Continuous snap sync enabled - will automatically follow new blocks as they arrive";
      response.status.initialTarget = targetBlock;
    }

    return res.status(202).json(response);
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
 * Process a single block with SEQUENTIAL transaction sending and PARALLEL receipt validation
 * Transactions are sent one by one, then all receipts are validated in parallel
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

  // 📤 SEQUENTIAL SENDING - Send transactions one by one
  logger.info(`📤 Sending ${transactions.length} transactions SEQUENTIALLY...`);

  const startTime = Date.now();

  // Send all transactions sequentially
  const txResults: TransactionResult[] = [];

  for (let index = 0; index < transactions.length; index++) {
    const tx = transactions[index];
    try {
      const txWithHash = tx as TransactionWithHash;
      const txHash = txWithHash.transaction_hash;

      logger.debug(
        `  📤 [${index + 1}/${transactions.length}] Sending tx: ${txHash}`,
      );

      // Process the transaction (send it to syncing node)
      await processTx(txWithHash, blockNumber);

      txResults.push({
        txHash,
        success: true,
      });
    } catch (error: any) {
      logger.error(
        `  ❌ Failed to send transaction ${index + 1}:`,
        error.message,
      );
      throw new Error(
        `Failed to send transaction ${index + 1}/${transactions.length} in block ${blockNumber}: ${error.message}`,
      );
    }
  }

  const sendDuration = Date.now() - startTime;
  logger.info(`✅ All transactions sent sequentially in ${sendDuration}ms`);

  // ⚡ PARALLEL RECEIPT VALIDATION - Wait for all receipts at once
  logger.info(`⚡ Waiting for ${transactions.length} receipts in PARALLEL...`);

  const receiptStartTime = Date.now();

  const receiptPromises = txResults.map(async (result) => {
    try {
      await validateTransactionReceipt(syncingProvider_v9, result.txHash, {
        maxRetries: 2000,
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
    `⚡ Block ${blockNumber} completed in ${totalDuration}ms (${transactions.length} txs sent sequentially, receipts validated in parallel)`,
  );
}

/**
 * Async function to process blocks sequentially, with sequential tx sending and parallel receipt validation
 * 🆕 Now supports continuous sync mode
 */
async function snapSyncBlocksAsync(process: SnapSyncProcess): Promise<void> {
  try {
    const mode = process.isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `Starting snap sync from block ${process.currentBlock} to ${process.endBlock} [${mode}]`,
    );

    let currentBlock = process.currentBlock;

    // 🆕 Continuous sync loop - never exits naturally if continuous
    while (process.isContinuous || currentBlock <= process.endBlock) {
      // Check for cancellation
      if (process.cancelRequested) {
        await persistence.updateStatus(process.id, "cancelled");
        stopSnapProbeLoop();
        currentSnapSyncProcess = null;
        logger.info(
          `🛑 Snap sync process ${process.id} cancelled at block ${currentBlock}`,
        );
        return;
      }

      // 🆕 For continuous sync: if caught up, wait for new blocks
      if (process.isContinuous && currentBlock > process.endBlock) {
        logger.info(
          `⏸️  Caught up to target block ${process.endBlock}, waiting for new blocks...`,
        );
        logger.info(`🔍 Probe will check for new blocks every 60 seconds`);

        // Wait for 5 seconds, then check again
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue; // Go back to loop start and check again
      }

      process.currentBlock = currentBlock;
      logger.info(`\n⚡ SNAP SYNCING Block ${currentBlock}`);

      try {
        // Validate block order
        await validateBlock(currentBlock);

        // Set custom headers for the block
        await setCustomHeader(currentBlock);

        // Process block with SEQUENTIAL tx sending and PARALLEL receipt validation
        await snapSyncBlock(currentBlock, process);

        // Close the block
        await closeBlock();

        // 🔍 CRITICAL: Verify block hash matches - stops sync if hashes don't match
        try {
          await matchBlockHash(currentBlock);
          logger.info(`✅ Block hash verified for block ${currentBlock}`);
        } catch (error: any) {
          const errorMsg = `❌ BLOCK HASH MISMATCH at block ${currentBlock}. Stopping snap sync.`;
          logger.error(errorMsg);
          logger.error(`Block hash verification error:`, error);

          // Update process status
          process.status = "failed";
          process.error = errorMsg;

          // Update Redis
          await persistence.updateStatus(process.id, "failed");

          // Stop probe loop
          stopSnapProbeLoop();

          // Clear current process
          currentSnapSyncProcess = null;

          // Throw error to stop the sync
          throw new Error(errorMsg);
        }

        process.processedBlocks++;

        // Update Redis timestamp
        await persistence.updateLastChecked(process.id);

        const percentComplete = process.isContinuous
          ? "N/A (continuous)"
          : ((process.processedBlocks / process.totalBlocks) * 100).toFixed(2) +
            "%";

        logger.info(
          `✅ Block ${currentBlock} completed (${process.processedBlocks} blocks processed, ${percentComplete} complete)`,
        );

        // Move to next block
        currentBlock++;
      } catch (error) {
        // Error handling - only update status if not already updated
        if (process.status !== "failed") {
          await persistence.updateStatus(process.id, "failed");
        }
        stopSnapProbeLoop();
        logger.error(`❌ Failed to process block ${currentBlock}:`, error);
        throw error;
      }
    }

    // 🆕 This only executes for non-continuous sync (fixed range completed)
    if (!process.isContinuous) {
      process.status = "completed";
      process.endTime = new Date();
      await persistence.updateStatus(process.id, "completed");
      stopSnapProbeLoop();
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
    }
  } catch (error) {
    process.status = "failed";
    process.error = error instanceof Error ? error.message : String(error);

    stopSnapProbeLoop();
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

    const mode = currentSnapSyncProcess.isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `🛑 Cancellation requested for snap sync process ${currentSnapSyncProcess.id} [${mode}]`,
    );

    const response: any = {
      message:
        "Snap sync cancellation requested - will stop after current block completes",
      processId: currentSnapSyncProcess.id,
      currentBlock: currentSnapSyncProcess.currentBlock,
      note: "Current block will complete all transactions before stopping",
    };

    // 🆕 Add continuous sync info
    if (currentSnapSyncProcess.isContinuous) {
      response.mode = "continuous";
      response.continuousSyncNote =
        "This was a continuous snap sync process. Probe loop will be stopped.";
      response.currentTarget = currentSnapSyncProcess.endBlock;
      response.originalTarget = currentSnapSyncProcess.originalTarget;
    }

    return res.json(response);
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

    const percentComplete = currentSnapSyncProcess.isContinuous
      ? "N/A (continuous sync)"
      : currentSnapSyncProcess.totalBlocks > 0
        ? (
            (currentSnapSyncProcess.processedBlocks /
              currentSnapSyncProcess.totalBlocks) *
            100
          ).toFixed(2) + "%"
        : "0.00%";

    const runningFor = currentSnapSyncProcess.endTime
      ? currentSnapSyncProcess.endTime.getTime() -
        currentSnapSyncProcess.startTime.getTime()
      : Date.now() - currentSnapSyncProcess.startTime.getTime();

    const response: any = {
      processId: currentSnapSyncProcess.id,
      status: currentSnapSyncProcess.status,
      mode: currentSnapSyncProcess.isContinuous
        ? "continuous-parallel"
        : "sequential-send-parallel-receipt",
      progress: {
        currentBlock: currentSnapSyncProcess.currentBlock,
        endBlock: currentSnapSyncProcess.endBlock,
        processedBlocks: currentSnapSyncProcess.processedBlocks,
        totalBlocks: currentSnapSyncProcess.isContinuous
          ? "N/A (continuous)"
          : currentSnapSyncProcess.totalBlocks,
        percentComplete,
      },
      timing: {
        startTime: currentSnapSyncProcess.startTime,
        endTime: currentSnapSyncProcess.endTime,
        runningFor: `${(runningFor / 1000).toFixed(2)}s`,
      },
      error: currentSnapSyncProcess.error,
    };

    // 🆕 Add continuous sync specific info
    if (currentSnapSyncProcess.isContinuous) {
      response.continuousSync = {
        enabled: true,
        originalTarget: currentSnapSyncProcess.originalTarget,
        currentTarget: currentSnapSyncProcess.endBlock,
        blocksAddedDynamically:
          currentSnapSyncProcess.endBlock -
          (currentSnapSyncProcess.originalTarget || 0),
      };
    }

    return res.json(response);
  } catch (error: any) {
    logger.error("Error getting snap sync status:", error);
    return res.status(500).json({
      error: `Failed to get snap sync status: ${error.message || error}`,
    });
  }
};
