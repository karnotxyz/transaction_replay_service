import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import logger from "./logger.js";
import { BlockIdentifier, TransactionWithHash, BlockTag } from "starknet";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
import { SyncProcess } from "./types.js";
import { persistence } from "./persistence.js";
import { syncStateManager } from "./state/index.js";
import { probeManager } from "./probe/index.js";
import { blockProcessor } from "./sync/BlockProcessor.js";
import { parallelTransactionProcessor } from "./sync/TransactionProcessor.js";
import {
  getLatestBlockNumber,
  getBlockWithTxs,
} from "./operations/blockOperations.js";
import { HttpStatus, ProcessStatus, ProbeConfig } from "./constants.js";
import {
  incrementBlocksProcessed,
  recordBlockStatus,
  updateCurrentBlock,
} from "./telemetry/metrics.js";
import {
  throughputTracker,
  updateSyncMetrics,
  updateActiveSyncProcessCount,
} from "./telemetry/throughput.js";
import {
  SyncInProgressError,
  InvalidBlockError,
  MadaraDownError,
} from "./errors/index.js";

/**
 * Start a sync process (for auto-resume and API)
 */
export async function startSync(endBlock: BlockIdentifier) {
  if (syncStateManager.isSyncRunning()) {
    const currentProcess = syncStateManager.getProcess()!;
    throw new SyncInProgressError(
      `Sync already in progress. Process ID: ${currentProcess.id}, Current block: ${currentProcess.currentBlock}, Target: ${currentProcess.syncTo}`,
      {
        processId: currentProcess.id,
        currentBlock: currentProcess.currentBlock,
        currentTxIndex: 0,
        syncFrom: currentProcess.syncFrom,
        syncTo: currentProcess.syncTo,
        isContinuous: currentProcess.isContinuous || false,
      },
    );
  }

  const isContinuous =
    endBlock === BlockTag.LATEST || endBlock === "latest" || endBlock === null;

  const targetBlock = await getTargetBlock(endBlock);

  const syncingNodeLatestBlock = await getLatestBlockNumber(syncingProvider_v9);
  const startBlock = syncingNodeLatestBlock + 1;

  if (startBlock > targetBlock) {
    return {
      success: true,
      alreadyComplete: true,
      message: "Syncing node is already at or beyond target block",
      currentBlock: syncingNodeLatestBlock,
      targetBlock: targetBlock,
      syncFrom: targetBlock,
      syncTo: targetBlock,
    };
  }

  const processId = uuidv4();
  const newProcess: SyncProcess = {
    id: processId,
    status: ProcessStatus.RUNNING,
    syncFrom: startBlock,
    syncTo: targetBlock,
    currentBlock: startBlock,
    currentTxIndex: 0,
    totalBlocks: targetBlock - startBlock + 1,
    processedBlocks: 0,
    startTime: new Date(),
    cancelRequested: false,
    isContinuous,
    originalTarget: isContinuous ? targetBlock : undefined,
  };

  syncStateManager.setProcess(newProcess);

  // Save state to file
  persistence.startSync(isContinuous ? "latest" : targetBlock, isContinuous);

  const mode = isContinuous ? "CONTINUOUS (following latest)" : "FIXED";
  logger.info(`🚀 Starting SYNC process ${processId} [${mode}]`);
  logger.info(
    `📊 Range: Block ${startBlock} → ${targetBlock} (${newProcess.totalBlocks} blocks)`,
  );
  logger.info(`⚡ Mode: SEQUENTIAL sending, PARALLEL receipt validation`);

  if (isContinuous) {
    logger.info(
      `🔄 Continuous sync enabled - will track new blocks as they arrive`,
    );
    logger.info(`📍 Initial target: block ${targetBlock}`);
    const probeInterval = probeManager.createProbeInterval(newProcess);
    syncStateManager.setProbeInterval(probeInterval);
  }

  // Mark sync as active
  updateActiveSyncProcessCount("sync", true);

  syncBlocksAsync(newProcess).catch(async (error) => {
    logger.error(`❌ Sync process ${processId} failed:`, error);
    if (newProcess.isContinuous) {
      syncStateManager.stopProbe();
    }
    syncStateManager.clearProcess();
    updateActiveSyncProcessCount("sync", false);
    // Mark sync as stopped on failure
    persistence.stopSync();
  });

  return {
    success: true,
    processId,
    syncFrom: startBlock,
    syncTo: targetBlock,
    estimatedBlocks: newProcess.totalBlocks,
    isContinuous,
  };
}

/**
 * Sync Endpoint Handler
 */
export const syncEndpoint = async (req: Request, res: Response) => {
  try {
    const { endBlock }: { endBlock: BlockIdentifier } = req.body;

    if (!endBlock && endBlock !== 0) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: "Missing required field: endBlock",
      });
    }

    const result = await startSync(endBlock);

    if (result.alreadyComplete) {
      return res.status(HttpStatus.OK).json({
        message: result.message,
        alreadyComplete: true,
        currentBlock: result.currentBlock,
        targetBlock: result.targetBlock,
      });
    }

    const response: any = {
      message: "Sync process started successfully",
      processId: result.processId,
      mode: result.isContinuous ? "continuous" : "fixed",
      status: {
        startBlock: result.syncFrom,
        endBlock: result.syncTo,
        totalBlocks: result.estimatedBlocks,
      },
    };

    if (result.isContinuous) {
      response.continuousSyncNote =
        "Continuous sync enabled - will automatically follow new blocks as they arrive";
      response.status.initialTarget = result.syncTo;
    }

    return res.status(HttpStatus.ACCEPTED).json(response);
  } catch (error: any) {
    if (error.code === "SYNC_IN_PROGRESS") {
      return res.status(HttpStatus.CONFLICT).json({
        error: error.message,
        details: error.details,
      });
    }
    logger.error("Error starting sync process:", error);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: `Failed to start sync: ${error.message || error}`,
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
      throw new InvalidBlockError(`Invalid block identifier: ${endBlock}`);
    }
    return parsed;
  }

  throw new InvalidBlockError(`Unsupported endBlock type: ${typeof endBlock}`);
}

/**
 * Process a single block with SEQUENTIAL transaction sending and PARALLEL receipt validation
 * Returns the number of transactions processed
 */
async function processBlock(
  blockNumber: number,
  process: SyncProcess,
): Promise<number> {
  const blockWithTxs = await getBlockWithTxs(originalProvider_v9, blockNumber);

  const transactions = blockWithTxs.transactions;
  logger.info(
    `📦 Block ${blockNumber}: Found ${transactions.length} transactions`,
  );

  if (transactions.length === 0) {
    logger.info(`⏭️  Block ${blockNumber} has no transactions, skipping...`);
    return 0;
  }

  try {
    // Use parallel transaction processor
    await parallelTransactionProcessor.processTransactions(
      transactions as TransactionWithHash[],
      blockNumber,
    );
  } catch (error) {
    // If the error message indicates a restart is needed, propagate it
    if (error instanceof Error && error.message.includes("Restarting block")) {
      throw error;
    }
    throw error;
  }

  return transactions.length;
}

/**
 * Async function to process blocks
 */
async function syncBlocksAsync(process: SyncProcess): Promise<void> {
  try {
    const mode = process.isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `Starting sync from block ${process.currentBlock} to ${process.syncTo} [${mode}]`,
    );

    let currentBlock = process.currentBlock;

    while (process.isContinuous || currentBlock <= process.syncTo) {
      // Check for cancellation
      if (process.cancelRequested) {
        persistence.stopSync();
        syncStateManager.stopProbe();
        syncStateManager.clearProcess();
        updateActiveSyncProcessCount("sync", false);
        logger.info(
          `🛑 Sync process ${process.id} cancelled at block ${currentBlock}`,
        );
        return;
      }

      // For continuous sync: if caught up, wait for new blocks
      if (process.isContinuous && currentBlock > process.syncTo) {
        logger.info(
          `⏸️  Caught up to target block ${process.syncTo}, waiting for new blocks...`,
        );
        logger.info(`🔍 Probe will check for new blocks every 60 seconds`);

        await new Promise((resolve) =>
          setTimeout(resolve, ProbeConfig.CAUGHT_UP_WAIT_MS),
        );
        continue;
      }

      process.currentBlock = currentBlock;

      // Update current block metric
      updateCurrentBlock(currentBlock);

      logger.info(`⚡ SYNCING Block ${currentBlock}`);

      try {
        // Validate block
        const validateResult = await blockProcessor.validateBlockReady(
          currentBlock,
          process,
        );
        if (!validateResult.success) {
          throw validateResult.error;
        }

        // Set custom headers
        const headersResult = await blockProcessor.setBlockHeaders(
          currentBlock,
          process,
        );
        if (!headersResult.success) {
          throw headersResult.error;
        }

        // Process block with parallel transaction processing
        let blockNeedsRestart = false;
        let txCount = 0;
        try {
          txCount = await processBlock(currentBlock, process);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("Restarting block")
          ) {
            blockNeedsRestart = true;
          } else if (error instanceof MadaraDownError) {
            // Handle Madara recovery
            logger.warn(
              `🚨 Madara down detected during sync at block ${currentBlock}`,
            );

            const recoveryResult = await blockProcessor.handleBlockRecovery(
              currentBlock,
              process,
            );

            if (!recoveryResult.recovered) {
              throw new Error(
                `Madara recovery failed at block ${currentBlock}`,
              );
            }

            blockNeedsRestart = true;
          } else {
            throw error;
          }
        }

        if (blockNeedsRestart) {
          logger.info(
            `🔄 Restarting block ${currentBlock} after Madara recovery`,
          );
          continue;
        }

        // Close the block
        const closeResult = await blockProcessor.closeCurrentBlock(
          currentBlock,
          process,
        );
        if (!closeResult.success) {
          throw closeResult.error;
        }

        // Verify block hash
        const verifyResult = await blockProcessor.verifyBlockHash(
          currentBlock,
          process,
        );
        if (!verifyResult.success) {
          throw verifyResult.error;
        }

        // Record successful block processing metrics
        incrementBlocksProcessed();
        recordBlockStatus("success");

        // Update throughput metrics
        throughputTracker.recordBlock(txCount);

        process.processedBlocks++;

        // Update sync progress metrics
        const originalNodeLatest =
          await getLatestBlockNumber(originalProvider_v9);
        const syncingNodeLatest =
          await getLatestBlockNumber(syncingProvider_v9);
        updateSyncMetrics(process, originalNodeLatest, syncingNodeLatest);

        const percentComplete = process.isContinuous
          ? "N/A (continuous)"
          : ((process.processedBlocks / process.totalBlocks!) * 100).toFixed(
            2,
          ) + "%";

        logger.info(
          `✅ Block ${currentBlock} completed (${process.processedBlocks} blocks processed, ${percentComplete} complete)`,
        );

        currentBlock++;
      } catch (error) {
        // Record failed block processing metric
        recordBlockStatus("failed");

        process.status = ProcessStatus.FAILED;
        syncStateManager.stopProbe();
        logger.error(`❌ Failed to process block ${currentBlock}:`, error);
        throw error;
      }
    }

    if (!process.isContinuous) {
      process.status = ProcessStatus.COMPLETED;
      process.endTime = new Date();
      persistence.stopSync();
      syncStateManager.stopProbe();
      syncStateManager.clearProcess();
      updateActiveSyncProcessCount("sync", false);

      const duration = process.endTime.getTime() - process.startTime.getTime();
      const durationSeconds = (duration / 1000).toFixed(2);

      logger.info(`🎉 SYNC COMPLETED!`);
      logger.info(`✅ Process ${process.id} finished successfully`);
      logger.info(
        `📊 Processed ${process.processedBlocks} blocks in ${durationSeconds}s`,
      );
      logger.info(
        `📍 Range: ${process.currentBlock - process.processedBlocks + 1} → ${process.currentBlock - 1}`,
      );
    }
  } catch (error) {
    process.status = ProcessStatus.FAILED;
    process.error = error instanceof Error ? error.message : String(error);

    syncStateManager.stopProbe();
    syncStateManager.clearProcess();
    updateActiveSyncProcessCount("sync", false);
    logger.error(`❌ Sync process ${process.id} failed:`, error);
    throw error;
  }
}

/**
 * Cancel the current sync process
 */
export const cancelSync = async (req: Request, res: Response) => {
  try {
    const currentProcess = syncStateManager.getProcess();

    if (!currentProcess) {
      return res.status(HttpStatus.NOT_FOUND).json({
        error: "No sync process currently running",
      });
    }

    if (currentProcess.status !== ProcessStatus.RUNNING) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: `Sync process is not running (current status: ${currentProcess.status})`,
        processId: currentProcess.id,
        status: currentProcess.status,
      });
    }

    currentProcess.cancelRequested = true;

    const mode = currentProcess.isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `🛑 Cancellation requested for sync process ${currentProcess.id} [${mode}]`,
    );

    const response: any = {
      message:
        "Sync cancellation requested - will stop after current block completes",
      processId: currentProcess.id,
      currentBlock: currentProcess.currentBlock,
      note: "Current block will complete all transactions before stopping",
    };

    if (currentProcess.isContinuous) {
      response.mode = "continuous";
      response.continuousSyncNote =
        "This was a continuous sync process. Probe loop will be stopped.";
      response.currentTarget = currentProcess.syncTo;
      response.originalTarget = currentProcess.originalTarget;
    }

    return res.json(response);
  } catch (error: any) {
    logger.error("Error cancelling sync process:", error);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: `Failed to cancel sync: ${error.message || error}`,
    });
  }
};

/**
 * Get sync status
 */
export const getSyncStatus = async (req: Request, res: Response) => {
  try {
    const currentProcess = syncStateManager.getProcess();

    if (!currentProcess) {
      return res.json({
        message: "No sync process currently running",
      });
    }

    const percentComplete = currentProcess.isContinuous
      ? "N/A (continuous sync)"
      : currentProcess.totalBlocks! > 0
        ? (
          (currentProcess.processedBlocks / currentProcess.totalBlocks!) *
          100
        ).toFixed(2) + "%"
        : "0.00%";

    const runningFor = currentProcess.endTime
      ? currentProcess.endTime.getTime() - currentProcess.startTime.getTime()
      : Date.now() - currentProcess.startTime.getTime();

    const response: any = {
      processId: currentProcess.id,
      status: currentProcess.status,
      mode: currentProcess.isContinuous ? "continuous" : "fixed",
      progress: {
        currentBlock: currentProcess.currentBlock,
        endBlock: currentProcess.syncTo,
        processedBlocks: currentProcess.processedBlocks,
        totalBlocks: currentProcess.isContinuous
          ? "N/A (continuous)"
          : currentProcess.totalBlocks,
        percentComplete,
      },
      timing: {
        startTime: currentProcess.startTime,
        endTime: currentProcess.endTime,
        runningFor: `${(runningFor / 1000).toFixed(2)}s`,
      },
      error: currentProcess.error,
    };

    if (currentProcess.isContinuous) {
      response.continuousSync = {
        enabled: true,
        originalTarget: currentProcess.originalTarget,
        currentTarget: currentProcess.syncTo,
        blocksAddedDynamically:
          currentProcess.syncTo - (currentProcess.originalTarget || 0),
      };
    }

    return res.json(response);
  } catch (error: any) {
    logger.error("Error getting sync status:", error);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: `Failed to get sync status: ${error.message || error}`,
    });
  }
};
