import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import logger from "./logger.js";
import { BlockIdentifier, TransactionWithHash, BlockTag } from "starknet";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
import { SyncProcess } from "./types.js";
import { persistence } from "./persistence.js";
import { syncStateManager } from "./state/index.js";
import { probeManager } from "./probe/index.js";
import { blockProcessor, RecoveryAction } from "./sync/BlockProcessor.js";
import { parallelTransactionProcessor } from "./sync/TransactionProcessor.js";
import {
  getLatestBlockNumber,
  getOriginalBlockWithTxsAndProofFacts,
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
  BlockAlignmentError,
  BlockHashMismatchError,
} from "./errors/index.js";
import { reconcileManager } from "./reconcile/index.js";

interface StartSyncOptions {
  startBlock?: number;
  skipReconcile?: boolean;
}

class SyncInterruptedForReconcileError extends Error {
  constructor() {
    super("Sync interrupted for reconcile");
    this.name = "SyncInterruptedForReconcileError";
  }
}

/**
 * Start a sync process (for auto-resume and API)
 */
export async function startSync(
  endBlock: BlockIdentifier,
  options: StartSyncOptions = {},
) {
  if (syncStateManager.hasActiveProcess()) {
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

  let preflightHead: number | null = null;
  if (!options.skipReconcile) {
    const reconcileResult = await reconcileManager.ensureHealthyBeforeSync();

    if (
      reconcileResult.status !== "healthy" &&
      reconcileResult.status !== "repaired"
    ) {
      throw new Error(
        `Unable to start sync until reconcile succeeds: ${reconcileResult.error || reconcileResult.status}`,
      );
    }

    preflightHead = reconcileResult.localHead;
  }

  const targetBlock = await getTargetBlock(endBlock);

  const syncingNodeLatestBlock =
    preflightHead ?? await getLatestBlockNumber(syncingProvider_v9);
  const startBlock = options.startBlock ?? (syncingNodeLatestBlock + 1);

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
    reconcileRequested: false,
    lastVerifiedBlock: null,
    lastVerifiedHash: null,
  };

  syncStateManager.setProcess(newProcess);

  // Save state to file
  persistence.startSync(
    isContinuous ? "latest" : targetBlock,
    isContinuous,
    startBlock,
  );

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

  const runPromise = syncBlocksAsync(newProcess);
  syncStateManager.setRunPromise(runPromise);

  runPromise.catch(async (error) => {
    logger.error(`❌ Sync process ${processId} failed:`, error);
    if (newProcess.isContinuous) {
      syncStateManager.stopProbe();
    }
    syncStateManager.clearProcess();
    updateActiveSyncProcessCount("sync", false);
    // Mark sync as stopped on failure
    const state = persistence.readState();
    if (
      !state ||
      (state.status !== "reconciling" && state.status !== "reconcile_failed")
    ) {
      persistence.stopSync();
    }
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

function throwIfReconcileRequested(process: SyncProcess): void {
  if (process.reconcileRequested) {
    throw new SyncInterruptedForReconcileError();
  }
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
 *
 * @param blockNumber - The block number to process
 * @param process - The sync process
 * @param existingTxHashes - Optional list of tx hashes already in Madara's pending block (for recovery)
 */
interface ProcessBlockResult {
  txCount: number;
  txHashes: string[];
}

async function processBlock(
  blockNumber: number,
  process: SyncProcess,
  existingTxHashes: string[] = [],
): Promise<ProcessBlockResult> {
  const blockWithTxs = await getOriginalBlockWithTxsAndProofFacts(blockNumber);

  let transactions = blockWithTxs.transactions as TransactionWithHash[];
  const totalTxCount = transactions.length;

  logger.info(
    `📦 Block ${blockNumber}: Found ${totalTxCount} transactions`,
  );

  // If we have existing transactions (recovery scenario), filter them out
  if (existingTxHashes.length > 0) {
    const existingSet = new Set(existingTxHashes);
    const originalCount = transactions.length;
    transactions = transactions.filter(
      (tx) => !existingSet.has(tx.transaction_hash),
    );
    logger.info(
      `🔄 Recovery mode: ${existingTxHashes.length} transactions already in Madara, sending ${transactions.length} remaining`,
    );

    if (transactions.length === 0) {
      logger.info(
        `✅ All ${originalCount} transactions already in Madara's pending block`,
      );
      // Return all tx hashes (existing + none new) for receipt validation
      return { txCount: totalTxCount, txHashes: existingTxHashes };
    }
  }

  if (transactions.length === 0) {
    logger.info(`⏭️  Block ${blockNumber} has no transactions, skipping...`);
    return { txCount: 0, txHashes: [] };
  }

  try {
    // Send transactions (no receipt validation yet - that happens after closeBlock)
    const result = await parallelTransactionProcessor.sendTransactions(
      transactions,
      blockNumber,
    );
    // Combine existing tx hashes with newly sent ones for receipt validation
    const allTxHashes = [...existingTxHashes, ...result.txHashes];
    return { txCount: totalTxCount, txHashes: allTxHashes };
  } catch (error) {
    // If the error message indicates a restart is needed, propagate it
    if (error instanceof Error && error.message.includes("Restarting block")) {
      throw error;
    }
    throw error;
  }
}

/**
 * Handle recovery action returned by blockProcessor.handleBlockRecovery
 * Returns the new block number to continue from, or throws if recovery failed
 */
function handleRecoveryAction(
  action: RecoveryAction,
  currentBlock: number,
): { newBlock: number; existingTxHashes: string[] } {
  switch (action.type) {
    case "restart_block":
      logger.info(`🔄 Restarting block ${action.blockNumber} from scratch`);
      return { newBlock: action.blockNumber, existingTxHashes: [] };

    case "continue_block":
      logger.info(
        `🔄 Continuing block ${action.blockNumber} with ${action.existingTxHashes.length} existing transactions`,
      );
      return {
        newBlock: action.blockNumber,
        existingTxHashes: action.existingTxHashes,
      };

    case "skip_to_block":
      logger.info(
        `⏭️ Skipping to block ${action.blockNumber} (Madara already ahead)`,
      );
      return { newBlock: action.blockNumber, existingTxHashes: [] };

    case "failed":
      throw new Error(`Recovery failed: ${action.error}`);
  }
}

async function recoverFromMadaraOutage(
  currentBlock: number,
  process: SyncProcess,
): Promise<{ newBlock: number; existingTxHashes: string[] }> {
  const recoveryResult = await blockProcessor.handleBlockRecovery(
    currentBlock,
    process,
  );

  if (!recoveryResult.recovered) {
    throw new Error(`Madara recovery failed at block ${currentBlock}`);
  }

  const handled = handleRecoveryAction(recoveryResult.action, currentBlock);

  if (recoveryResult.action.type === "skip_to_block") {
    const reconcileResult = await reconcileManager.handleRuntimeFault(
      Math.max(0, handled.newBlock - 1),
    );

    if (
      reconcileResult.status !== "healthy" &&
      reconcileResult.status !== "repaired"
    ) {
      throw new Error(
        `Reconcile after Madara recovery failed: ${reconcileResult.error || reconcileResult.status}`,
      );
    }

    return {
      newBlock: reconcileResult.resumeFrom ?? (reconcileResult.localHead + 1),
      existingTxHashes: [],
    };
  }

  return handled;
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
    // Track existing tx hashes for recovery scenarios (continue_block action)
    let existingTxHashes: string[] = [];

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

      throwIfReconcileRequested(process);

      // For continuous sync: if caught up, wait for new blocks
      if (process.isContinuous && currentBlock > process.syncTo) {
        logger.info(
          `⏸️  Caught up to target block ${process.syncTo}, waiting for new blocks...`,
        );
        logger.info(`🔍 Probe will check for new blocks every 60 seconds`);

        await new Promise((resolve) =>
          setTimeout(resolve, ProbeConfig.CAUGHT_UP_WAIT_MS),
        );
        throwIfReconcileRequested(process);
        continue;
      }

      process.currentBlock = currentBlock;
      persistence.markCurrentBlock(currentBlock);

      // Update current block metric
      updateCurrentBlock(currentBlock);

      logger.info(`⚡ SYNCING Block ${currentBlock}`);

      try {
        // Validate block (unless we're continuing with existing txs - block is already set up)
        if (existingTxHashes.length === 0) {
          throwIfReconcileRequested(process);
          const validateResult = await blockProcessor.validateBlockReady(
            currentBlock,
            process,
          );
          if (!validateResult.success) {
            throw validateResult.error;
          }

          // Set custom headers
          throwIfReconcileRequested(process);
          const headersResult = await blockProcessor.setBlockHeaders(
            currentBlock,
            process,
          );
          if (!headersResult.success) {
            throw headersResult.error;
          }
        } else {
          logger.info(
            `⏭️ Skipping validation/headers - continuing block with ${existingTxHashes.length} existing txs`,
          );
        }

        // Process block: send transactions (receipt validation happens after closeBlock)
        let blockResult: ProcessBlockResult = { txCount: 0, txHashes: [] };
        try {
          throwIfReconcileRequested(process);
          blockResult = await processBlock(currentBlock, process, existingTxHashes);
          // Clear existing tx hashes after successful processing
          existingTxHashes = [];
        } catch (error) {
          if (error instanceof MadaraDownError) {
            logger.warn(
              `🚨 Madara down detected during transaction sending at block ${currentBlock}`,
            );
            const { newBlock, existingTxHashes: recoveredTxHashes } =
              await recoverFromMadaraOutage(currentBlock, process);
            currentBlock = newBlock;
            existingTxHashes = recoveredTxHashes;
            continue;
          } else {
            throw error;
          }
        }

        // Validate all transactions are in PRE_CONFIRMED block before closing
        if (blockResult.txHashes.length > 0) {
          try {
            throwIfReconcileRequested(process);
            const validateTxResult = await blockProcessor.validateTransactionsBeforeClose(
              currentBlock,
              blockResult.txHashes,
              process,
            );
            if (!validateTxResult.success) {
              throw validateTxResult.error;
            }
          } catch (error) {
            if (error instanceof MadaraDownError) {
              logger.warn(
                `🚨 Madara down detected during pre-close validation at block ${currentBlock}`,
              );

              const { newBlock, existingTxHashes: recoveredTxHashes } =
                await recoverFromMadaraOutage(currentBlock, process);
              currentBlock = newBlock;
              existingTxHashes = recoveredTxHashes;
              continue;
            }
            throw error;
          }
        }

        // Close the block (must happen before receipt validation)
        let closeResult;
        try {
          throwIfReconcileRequested(process);
          closeResult = await blockProcessor.closeCurrentBlock(
            currentBlock,
            process,
          );
          if (!closeResult.success) {
            throw closeResult.error;
          }
        } catch (error) {
          if (error instanceof MadaraDownError) {
            logger.warn(
              `🚨 Madara down detected during closeBlock at block ${currentBlock}`,
            );
            const { newBlock, existingTxHashes: recoveredTxHashes } =
              await recoverFromMadaraOutage(currentBlock, process);
            currentBlock = newBlock;
            existingTxHashes = recoveredTxHashes;
            continue;
          }
          throw error;
        }

        // Validate receipts AFTER block is closed
        if (blockResult.txHashes.length > 0) {
          try {
            throwIfReconcileRequested(process);
            await parallelTransactionProcessor.validateReceipts(
              currentBlock,
              blockResult.txHashes,
            );
          } catch (error) {
            if (error instanceof MadaraDownError) {
              logger.warn(
                `🚨 Madara down detected during receipt validation at block ${currentBlock}`,
              );
              const { newBlock, existingTxHashes: recoveredTxHashes } =
                await recoverFromMadaraOutage(currentBlock, process);
              currentBlock = newBlock;
              existingTxHashes = recoveredTxHashes;
              continue;
            }
            throw error;
          }
        }

        // Verify block hash
        let verifyResult;
        try {
          throwIfReconcileRequested(process);
          verifyResult = await blockProcessor.verifyBlockHash(
            currentBlock,
            process,
          );
          if (!verifyResult.success) {
            throw verifyResult.error;
          }
        } catch (error) {
          if (error instanceof MadaraDownError) {
            logger.warn(
              `🚨 Madara down detected during hash verification at block ${currentBlock}`,
            );
            const { newBlock, existingTxHashes: recoveredTxHashes } =
              await recoverFromMadaraOutage(currentBlock, process);
            currentBlock = newBlock;
            existingTxHashes = recoveredTxHashes;
            continue;
          }
          throw error;
        }

        // Record successful block processing metrics
        incrementBlocksProcessed();
        recordBlockStatus("success");

        // Update throughput metrics
        throughputTracker.recordBlock(blockResult.txCount);

        process.processedBlocks++;
        process.lastVerifiedBlock = currentBlock;
        process.lastVerifiedHash = verifyResult.blockHash ?? null;

        if (process.lastVerifiedHash) {
          persistence.markBlockVerified(currentBlock, process.lastVerifiedHash);
        }

        // Update sync progress metrics
        // Use known values instead of making redundant RPC calls:
        // - originalNodeLatest: use process.syncTo (updated by probe for continuous sync)
        // - syncingNodeLatest: we just synced this block, so it's currentBlock
        updateSyncMetrics(process, process.syncTo, currentBlock);

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
        if (error instanceof SyncInterruptedForReconcileError) {
          process.status = ProcessStatus.RECONCILING;
          syncStateManager.stopProbe();
          syncStateManager.clearProcess();
          updateActiveSyncProcessCount("sync", false);
          logger.info(
            `⏸️ Sync process ${process.id} yielded for reconcile at block ${currentBlock}`,
          );
          return;
        }

        if (
          error instanceof BlockHashMismatchError ||
          error instanceof BlockAlignmentError
        ) {
          const anchorBlock =
            error instanceof BlockAlignmentError
              ? Math.max(error.currentBlock, error.latestBlock)
              : error.blockNumber;
          const reconcileResult = await reconcileManager.handleRuntimeFault(
            anchorBlock,
          );

          if (
            reconcileResult.status === "healthy" ||
            reconcileResult.status === "repaired"
          ) {
            existingTxHashes = [];
            currentBlock =
              reconcileResult.resumeFrom ?? (reconcileResult.localHead + 1);
            process.reconcileRequested = false;
            process.status = ProcessStatus.RUNNING;
            continue;
          }

          if (reconcileResult.status === "failed") {
            persistence.markReconcileFailed(true);
          } else if (reconcileResult.status === "deferred") {
            persistence.markReconciling(true);
          }
        }

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
        `📍 Range: ${process.syncFrom} → ${process.currentBlock}`,
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
      const state = persistence.readState();
      if (
        state &&
        (state.status === "reconciling" || state.status === "reconcile_failed")
      ) {
        return res.json({
          message:
            state.status === "reconciling"
              ? "Replay is currently reconciling the confirmed head"
              : "Replay reconcile is in a failed state",
          reconcile: {
            status: state.status,
            currentBlock: state.currentBlock,
            lastVerifiedBlock: state.lastVerifiedBlock,
            resumeAfterReconcile: state.resumeAfterReconcile,
            endBlock: state.syncTo,
          },
        });
      }

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

reconcileManager.registerStartSyncHandler(startSync);
