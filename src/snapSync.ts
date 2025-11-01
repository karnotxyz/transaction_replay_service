// snapSync.ts - PARALLEL SYNC WITH CONTINUOUS MODE SUPPORT AND MADARA RECOVERY
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
  MadaraDownError,
  waitForMadaraRecovery,
  getPreConfirmedBlock,
} from "./utils.js";
import { BlockIdentifier, TransactionWithHash, BlockTag } from "starknet";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
import { persistence } from "./persistence.js";
import { validateBlock } from "./syncing.js";

// Track the current snap sync process
export let currentSnapSyncProcess: SnapSyncProcess | null = null;

// Probe state management for snap sync
let snapProbeInterval: NodeJS.Timeout | null = null;
const SNAP_PROBE_INTERVAL_MS = 60 * 1000;
const SNAP_PROBE_MAX_RETRIES = 5;

interface SnapSyncProcess {
  id: string;
  status:
    | "running"
    | "completed"
    | "cancelled"
    | "failed"
    | "recovering";
  currentBlock: number;
  endBlock: number;
  totalBlocks: number;
  processedBlocks: number;
  startTime: Date;
  endTime?: Date;
  cancelRequested: boolean;
  error?: string;
  isContinuous?: boolean;
  originalTarget?: number;
}

interface TransactionResult {
  txHash: string;
  success: boolean;
  error?: string;
}

// Start the probe loop for continuous snap sync
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

// Stop the snap probe loop
function stopSnapProbeLoop(): void {
  if (snapProbeInterval) {
    clearInterval(snapProbeInterval);
    snapProbeInterval = null;
    logger.info("🛑 Snap probe loop stopped");
  }
}

// Probe function for snap sync with exponential backoff retry
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

        process.endBlock = latestBlock;
        process.totalBlocks =
          latestBlock - (process.currentBlock - process.processedBlocks) + 1;

        await persistence.updateSyncTarget(process.id, latestBlock);

        logger.info(
          `📈 Snap sync target updated: ${oldTarget} → ${latestBlock} (${newBlocks} new blocks detected)`,
        );
      } else {
        logger.debug(
          `🔍 Snap probe: No new blocks (latest: ${latestBlock}, target: ${process.endBlock})`,
        );
      }

      return;
    } catch (error) {
      lastError = error;
      retryCount++;

      if (retryCount < SNAP_PROBE_MAX_RETRIES) {
        const delay = Math.pow(2, retryCount) * 1000;
        logger.warn(
          `⚠️  Snap probe failed (attempt ${retryCount}/${SNAP_PROBE_MAX_RETRIES}), retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

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
 */
export const snapSyncEndpoint = async (req: Request, res: Response) => {
  try {
    const { endBlock }: { endBlock: BlockIdentifier } = req.body;

    if (!endBlock && endBlock !== 0) {
      return res.status(400).json({
        error: "Missing required field: endBlock",
      });
    }

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

    const isContinuous =
      endBlock === BlockTag.LATEST ||
      endBlock === "latest" ||
      endBlock === null;

    const targetBlock = await getTargetBlock(endBlock);

    const syncingNodeLatestBlock =
      await getLatestBlockNumber(syncingProvider_v9);
    const startBlock = syncingNodeLatestBlock + 1;

    if (startBlock > targetBlock) {
      return res.status(200).json({
        message: "Syncing node is already at or beyond target block",
        alreadyComplete: true,
        currentBlock: syncingNodeLatestBlock,
        targetBlock: targetBlock,
      });
    }

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
      startSnapProbeLoop(newProcess);
    }

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
 * Handle Madara recovery for snap sync
 */
async function handleSnapSyncMadaraRecovery(
  process: SnapSyncProcess,
  blockNumber: number,
): Promise<boolean> {
  logger.warn(
    `🚨 Madara down detected during snap sync at block ${blockNumber}`,
  );

  process.status = "recovering";

  const recovered = await waitForMadaraRecovery();

  if (!recovered) {
    logger.error(
      `❌ Snap sync Madara recovery failed - timeout exceeded (24 hours) at block ${blockNumber}`,
    );
    process.status = "failed";
    process.error =
      "Snap sync Madara recovery timeout - exceeded 24 hour wait period";
    return false;
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
      process.status = "failed";
      process.error = `PRE_CONFIRMED block mismatch after recovery`;
      return false;
    }

    if (preConfirmedTxCount === 0) {
      logger.info(
        `📭 PRE_CONFIRMED block ${blockNumber} is EMPTY - will restart block`,
      );
      process.status = "running";
      return true; // Signal to restart block
    } else {
      logger.info(
        `📦 PRE_CONFIRMED block ${blockNumber} has ${preConfirmedTxCount} transactions - will restart block to ensure consistency`,
      );
      process.status = "running";
      return true; // Signal to restart block (safer for parallel processing)
    }
  } catch (error) {
    logger.error(`❌ Failed to check PRE_CONFIRMED block state:`, error);
    process.status = "failed";
    process.error = `Failed to check PRE_CONFIRMED block state after recovery: ${error}`;
    return false;
  }
}

/**
 * Process a single block with SEQUENTIAL transaction sending and PARALLEL receipt validation
 * Includes Madara recovery handling
 */
async function snapSyncBlock(
  blockNumber: number,
  process: SnapSyncProcess,
): Promise<void> {
  try {
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

    logger.info(
      `📤 Sending ${transactions.length} transactions SEQUENTIALLY...`,
    );

    const startTime = Date.now();
    const txResults: TransactionResult[] = [];

    // SEQUENTIAL SENDING with Madara recovery
    for (let index = 0; index < transactions.length; index++) {
      const tx = transactions[index];
      try {
        const txWithHash = tx as TransactionWithHash;
        const txHash = txWithHash.transaction_hash;

        logger.debug(
          `  📤 [${index + 1}/${transactions.length}] Sending tx: ${txHash}`,
        );

        await processTx(txWithHash, blockNumber);

        txResults.push({
          txHash,
          success: true,
        });
      } catch (error: any) {
        if (error instanceof MadaraDownError) {
          logger.warn(
            `🚨 Madara down while sending transaction ${index + 1}/${transactions.length}`,
          );

          const recovered = await handleSnapSyncMadaraRecovery(
            process,
            blockNumber,
          );

          if (!recovered) {
            throw new Error(
              `Madara recovery failed at block ${blockNumber}, tx ${index + 1}`,
            );
          }

          // After recovery, restart the block
          throw new Error(
            `Restarting block ${blockNumber} after Madara recovery`,
          );
        }

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

    // PARALLEL RECEIPT VALIDATION with Madara recovery
    logger.info(
      `⚡ Waiting for ${transactions.length} receipts in PARALLEL...`,
    );

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
        if (error instanceof MadaraDownError) {
          // Don't catch here, let it bubble up
          throw error;
        }
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

    // Check for Madara down errors in receipt validation
    const madaraDownError = receiptResults.find(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof MadaraDownError,
    );

    if (madaraDownError) {
      logger.warn(
        `🚨 Madara down detected during parallel receipt validation`,
      );

      const recovered = await handleSnapSyncMadaraRecovery(
        process,
        blockNumber,
      );

      if (!recovered) {
        throw new Error(
          `Madara recovery failed during receipt validation at block ${blockNumber}`,
        );
      }

      // After recovery, restart the block
      throw new Error(
        `Restarting block ${blockNumber} after Madara recovery during receipt validation`,
      );
    }

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
  } catch (error) {
    // If the error message indicates a restart is needed, don't treat it as a failure
    if (
      error instanceof Error &&
      error.message.includes("Restarting block")
    ) {
      throw error; // Let the caller handle the restart
    }
    throw error;
  }
}

/**
 * Async function to process blocks sequentially, with Madara recovery support
 */
async function snapSyncBlocksAsync(process: SnapSyncProcess): Promise<void> {
  try {
    const mode = process.isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `Starting snap sync from block ${process.currentBlock} to ${process.endBlock} [${mode}]`,
    );

    let currentBlock = process.currentBlock;

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

      // For continuous sync: if caught up, wait for new blocks
      if (process.isContinuous && currentBlock > process.endBlock) {
        logger.info(
          `⏸️  Caught up to target block ${process.endBlock}, waiting for new blocks...`,
        );
        logger.info(`🔍 Probe will check for new blocks every 60 seconds`);

        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      process.currentBlock = currentBlock;
      logger.info(`\n⚡ SNAP SYNCING Block ${currentBlock}`);

      try {
        // Validate block with Madara recovery
        try {
          await validateBlock(currentBlock);
        } catch (error) {
          if (error instanceof MadaraDownError) {
            logger.warn(
              `🚨 Madara down during block validation for block ${currentBlock}`,
            );
            const recovered = await handleSnapSyncMadaraRecovery(
              process,
              currentBlock,
            );
            if (!recovered) {
              throw new Error(
                `Madara recovery failed during validation at block ${currentBlock}`,
              );
            }
            // Retry validation
            await validateBlock(currentBlock);
          } else {
            throw error;
          }
        }

        // Set custom headers with Madara recovery
        try {
          await setCustomHeader(currentBlock);
        } catch (error) {
          if (error instanceof MadaraDownError) {
            logger.warn(
              `🚨 Madara down during set headers for block ${currentBlock}`,
            );
            const recovered = await handleSnapSyncMadaraRecovery(
              process,
              currentBlock,
            );
            if (!recovered) {
              throw new Error(
                `Madara recovery failed during set headers at block ${currentBlock}`,
              );
            }

            // After recovery, check PRE_CONFIRMED state
            const preConfirmedBlock = await getPreConfirmedBlock(
              syncingProvider_v9,
            );
            if (preConfirmedBlock.transactions.length === 0) {
              logger.info(
                `🔄 Restarting block ${currentBlock} - PRE_CONFIRMED is empty`,
              );
              await setCustomHeader(currentBlock);
            } else {
              logger.info(
                `⚠️  Block ${currentBlock} has transactions in PRE_CONFIRMED - restarting block`,
              );
              continue; // Restart the block
            }
          } else {
            throw error;
          }
        }

        // Process block with Madara recovery (handled inside snapSyncBlock)
        let blockNeedsRestart = false;
        try {
          await snapSyncBlock(currentBlock, process);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("Restarting block")
          ) {
            blockNeedsRestart = true;
          } else {
            throw error;
          }
        }

        if (blockNeedsRestart) {
          logger.info(
            `🔄 Restarting block ${currentBlock} after Madara recovery`,
          );
          continue; // Restart the same block
        }

        // Close the block with Madara recovery
        try {
          await closeBlock();
        } catch (error) {
          if (error instanceof MadaraDownError) {
            logger.warn(
              `🚨 Madara down during close block for block ${currentBlock}`,
            );
            const recovered = await handleSnapSyncMadaraRecovery(
              process,
              currentBlock,
            );
            if (!recovered) {
              throw new Error(
                `Madara recovery failed during close block at block ${currentBlock}`,
              );
            }
            // Retry close block
            await closeBlock();
          } else {
            throw error;
          }
        }

        // Verify block hash with Madara recovery
        try {
          await matchBlockHash(currentBlock);
          logger.info(`✅ Block hash verified for block ${currentBlock}`);
        } catch (error: any) {
          if (error instanceof MadaraDownError) {
            logger.warn(
              `🚨 Madara down during hash verification for block ${currentBlock}`,
            );
            const recovered = await handleSnapSyncMadaraRecovery(
              process,
              currentBlock,
            );
            if (!recovered) {
              throw new Error(
                `Madara recovery failed during hash verification at block ${currentBlock}`,
              );
            }
            // Retry hash verification
            await matchBlockHash(currentBlock);
          } else {
            const errorMsg = `❌ BLOCK HASH MISMATCH at block ${currentBlock}. Stopping snap sync.`;
            logger.error(errorMsg);
            logger.error(`Block hash verification error:`, error);

            process.status = "failed";
            process.error = errorMsg;

            await persistence.updateStatus(process.id, "failed");
            stopSnapProbeLoop();
            currentSnapSyncProcess = null;

            throw new Error(errorMsg);
          }
        }

        process.processedBlocks++;

        await persistence.updateLastChecked(process.id);

        const percentComplete = process.isContinuous
          ? "N/A (continuous)"
          : ((process.processedBlocks / process.totalBlocks) * 100).toFixed(2) +
            "%";

        logger.info(
          `✅ Block ${currentBlock} completed (${process.processedBlocks} blocks processed, ${percentComplete} complete)`,
        );

        currentBlock++;
      } catch (error) {
        if (process.status !== "failed") {
          await persistence.updateStatus(process.id, "failed");
        }
        stopSnapProbeLoop();
        logger.error(`❌ Failed to process block ${currentBlock}:`, error);
        throw error;
      }
    }

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