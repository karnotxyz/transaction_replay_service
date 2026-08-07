import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import logger from "./logger.js";
import { BlockIdentifier, TransactionWithHash, BlockTag } from "starknet";
import {
  originalProvider,
  syncingProvider,
  supportsProofFacts,
} from "./providers.js";
import { SyncProcess } from "./types.js";
import { persistence } from "./persistence.js";
import { syncStateManager } from "./state/index.js";
import { probeManager } from "./probe/index.js";
import { blockProcessor, RecoveryAction } from "./sync/BlockProcessor.js";
import { parallelTransactionProcessor } from "./sync/TransactionProcessor.js";
import {
  getLatestBlockNumber,
  getBlockWithTxs,
  getOriginalBlockWithTxsAndProofFacts,
  getBlockWithReceipts,
} from "./operations/blockOperations.js";
import {
  BlockProcessing,
  HttpStatus,
  ProcessStatus,
  ProbeConfig,
} from "./constants.js";
import { assertSupportedBlockVersion } from "./validation/index.js";
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
  TransactionReplayFailedError,
} from "./errors/index.js";
import { config } from "./config.js";
import { ExecutionStatus, SyncRequest } from "./types.js";

/**
 * Start a sync process (for auto-resume and API)
 */
export async function startSync(
  endBlock: BlockIdentifier,
  startBlockOverride?: number,
  startTxIndex: number = 0,
  startTxHash?: string,
) {
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

  const syncingNodeLatestBlock = await getLatestBlockNumber(syncingProvider);
  const startBlock = startBlockOverride ?? syncingNodeLatestBlock + 1;

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
    currentTxIndex: startTxIndex,
    currentTxHash: startTxHash,
    totalBlocks: targetBlock - startBlock + 1,
    processedBlocks: 0,
    startTime: new Date(),
    cancelRequested: false,
    isContinuous,
    originalTarget: isContinuous ? targetBlock : undefined,
  };

  syncStateManager.setProcess(newProcess);

  // Save state to file
  persistence.startSync(
    isContinuous ? "latest" : targetBlock,
    isContinuous,
    startBlock,
    startTxIndex,
    startTxHash,
  );

  const mode = isContinuous ? "CONTINUOUS (following latest)" : "FIXED";
  logger.info(`🚀 Starting SYNC process ${processId} [${mode}]`);
  logger.info(
    `📊 Range: Block ${startBlock} → ${targetBlock} (${newProcess.totalBlocks} blocks)`,
  );
  if (startTxIndex > 0) {
    logger.info(
      `📍 Starting inside block ${startBlock} at tx index ${startTxIndex}`,
    );
  }
  if (startTxHash) {
    logger.info(
      `📍 Starting inside block ${startBlock} at tx hash ${startTxHash}`,
    );
  }
  const txMode = config.isTransactionOnlyReplay
    ? "TRANSACTION_ONLY managed-blocks-without-hash-match"
    : config.sequentialValidation
      ? "SEQUENTIAL send-and-validate (per-tx confirmation)"
      : "SEQUENTIAL sending, PARALLEL receipt validation";
  logger.info(`⚡ Mode: ${txMode}`);

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
    const {
      endBlock,
      startBlock,
      startTxIndex = 0,
      startTxHash,
    }: SyncRequest = req.body;

    if (!endBlock && endBlock !== 0) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: "Missing required field: endBlock",
      });
    }

    if (
      startBlock !== undefined &&
      (!Number.isInteger(startBlock) || startBlock < 0)
    ) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: "startBlock must be a non-negative integer",
      });
    }

    if (!Number.isInteger(startTxIndex) || startTxIndex < 0) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: "startTxIndex must be a non-negative integer",
      });
    }

    if (startTxHash !== undefined && typeof startTxHash !== "string") {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: "startTxHash must be a transaction hash string",
      });
    }

    const result = await startSync(
      endBlock,
      startBlock,
      startTxIndex,
      startTxHash,
    );

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
        startTxIndex,
        startTxHash,
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
    const latestBlock = await getLatestBlockNumber(originalProvider);
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

interface SourceBlockWithTxs {
  starknet_version?: string;
  transactions: TransactionWithHash[];
}

async function processBlock(
  blockNumber: number,
  process: SyncProcess,
  blockWithTxs: SourceBlockWithTxs,
  existingTxHashes: string[] = [],
): Promise<ProcessBlockResult> {
  let transactions = blockWithTxs.transactions as TransactionWithHash[];
  const totalTxCount = transactions.length;

  logger.info(`📦 Block ${blockNumber}: Found ${totalTxCount} transactions`);

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

async function getOriginalReceiptStatusMap(
  blockNumber: number,
  sourceTxs: TransactionWithHash[],
): Promise<Map<string, ExecutionStatus>> {
  const blockWithReceipts = await getBlockWithReceipts(
    originalProvider,
    blockNumber,
  );

  if (!blockWithReceipts) {
    throw new Error(
      `Original block receipts not found for block ${blockNumber}`,
    );
  }

  const statuses = new Map(
    blockWithReceipts.transactions.map((txWithReceipt) => [
      txWithReceipt.receipt.transaction_hash,
      txWithReceipt.receipt.execution_status,
    ]),
  );

  for (const tx of sourceTxs) {
    if (!statuses.has(tx.transaction_hash)) {
      throw new Error(
        `Original block ${blockNumber} is missing receipt for transaction ${tx.transaction_hash}`,
      );
    }
  }

  return statuses;
}

async function processTransactionOnlyBlock(
  blockNumber: number,
  blockWithTxs: SourceBlockWithTxs,
  startTxIndex: number = 0,
  startTxHash?: string,
  existingTxHashes: string[] = [],
): Promise<ProcessBlockResult> {
  const allTransactions = blockWithTxs.transactions as TransactionWithHash[];
  let effectiveStartTxIndex = startTxIndex;

  logger.info(
    `📦 Block ${blockNumber}: Found ${allTransactions.length} transactions`,
  );

  if (startTxIndex > 0) {
    logger.info(
      `📍 Transaction-only resume: skipping first ${startTxIndex} source transactions in block ${blockNumber}`,
    );
  }

  if (startTxHash) {
    const hashIndex = allTransactions.findIndex(
      (tx) => tx.transaction_hash === startTxHash,
    );
    if (hashIndex < 0) {
      throw new Error(
        `Transaction ${startTxHash} not found in source block ${blockNumber}`,
      );
    }
    effectiveStartTxIndex = hashIndex;
    logger.info(
      `📍 Transaction-only resume: starting at tx hash ${startTxHash} (index ${effectiveStartTxIndex}) in block ${blockNumber}`,
    );
  }

  let transactions = allTransactions.slice(effectiveStartTxIndex);

  if (allTransactions.length === 0) {
    logger.info(
      `⏭️  Block ${blockNumber} has no transactions, skipping in transaction-only mode`,
    );
    return { txCount: 0, txHashes: [] };
  }

  if (existingTxHashes.length > 0) {
    const existingSet = new Set(existingTxHashes);
    const originalRemainingCount = transactions.length;
    transactions = transactions.filter(
      (tx) => !existingSet.has(tx.transaction_hash),
    );
    logger.info(
      `🔄 Transaction-only recovery: ${existingTxHashes.length} transactions already in PRE_CONFIRMED, sending ${transactions.length}/${originalRemainingCount} remaining`,
    );
  }

  if (transactions.length === 0) {
    logger.info(
      `✅ Block ${blockNumber} has no remaining transactions from tx index ${startTxIndex}`,
    );
    return { txCount: allTransactions.length, txHashes: existingTxHashes };
  }

  const expectedExecutedCounts = transactions.map((tx) => {
    const originalIndex = allTransactions.findIndex(
      (sourceTx) => sourceTx.transaction_hash === tx.transaction_hash,
    );
    if (originalIndex < 0) {
      throw new Error(
        `Transaction ${tx.transaction_hash} not found in source block ${blockNumber}`,
      );
    }
    return originalIndex + 1;
  });

  const result =
    await parallelTransactionProcessor.sendTransactionsWithReplayBoundary(
      transactions,
      blockNumber,
      expectedExecutedCounts,
    );

  if (BlockProcessing.TX_DELAY_BETWEEN_TXS > 0) {
    logger.debug(
      `Transaction-only replay boundary pacing replaces fixed ${BlockProcessing.TX_DELAY_BETWEEN_TXS}ms inter-tx delay`,
    );
  }

  return {
    txCount: transactions.length,
    txHashes: [...existingTxHashes, ...result.txHashes],
  };
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

function getTransactionOnlyRecoveryBlock(action: RecoveryAction): number {
  switch (action.type) {
    case "restart_block":
    case "continue_block":
    case "skip_to_block":
      return action.blockNumber;
    case "failed":
      throw new Error(`Recovery failed: ${action.error}`);
  }
}

/**
 * Async function to process blocks
 */
async function syncBlocksAsync(process: SyncProcess): Promise<void> {
  try {
    const mode = process.isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `🚀 Starting sync from block ${process.currentBlock} to ${process.syncTo} [${mode}]`,
    );

    let currentBlock = process.currentBlock;
    let startTxIndex = process.currentTxIndex || 0;
    let startTxHash = process.currentTxHash;
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
      process.currentTxIndex = startTxIndex;
      process.currentTxHash = startTxHash;
      persistence.updateProgress(currentBlock, startTxIndex, startTxHash);

      // Update current block metric
      updateCurrentBlock(currentBlock);

      logger.info(`⚡ SYNCING Block ${currentBlock}`);

      try {
        const sourceBlock = supportsProofFacts()
          ? await getOriginalBlockWithTxsAndProofFacts(currentBlock)
          : ((await getBlockWithTxs(
              originalProvider,
              currentBlock,
            )) as SourceBlockWithTxs);
        assertSupportedBlockVersion(currentBlock, sourceBlock.starknet_version);

        if (config.isTransactionOnlyReplay) {
          let blockResult: ProcessBlockResult = { txCount: 0, txHashes: [] };

          try {
            const originalStatuses = await getOriginalReceiptStatusMap(
              currentBlock,
              sourceBlock.transactions,
            );

            if (
              startTxIndex === 0 &&
              !startTxHash &&
              existingTxHashes.length === 0
            ) {
              const validateResult = await blockProcessor.validateBlockReady(
                currentBlock,
                process,
              );
              if (!validateResult.success) {
                throw validateResult.error;
              }

              const headersResult = await blockProcessor.setBlockHeaders(
                currentBlock,
                process,
              );
              if (!headersResult.success) {
                throw headersResult.error;
              }
            } else {
              logger.info(
                `⏭️ Transaction-only resume: skipping validation/headers for block ${currentBlock}`,
              );
            }

            const expectedTxHashes = (
              sourceBlock.transactions as TransactionWithHash[]
            ).map((tx) => tx.transaction_hash);
            if (expectedTxHashes.length > 0) {
              const boundaryResult =
                await blockProcessor.setTransactionOnlyReplayBoundary(
                  currentBlock,
                  expectedTxHashes,
                );
              if (!boundaryResult.success) {
                throw boundaryResult.error;
              }
            }

            blockResult = await processTransactionOnlyBlock(
              currentBlock,
              sourceBlock,
              startTxIndex,
              startTxHash,
              existingTxHashes,
            );
            existingTxHashes = [];

            logger.info(
              `⏭️ Transaction-only mode: skipped PRE_CONFIRMED tx-list validation for block ${currentBlock}`,
            );

            if (blockResult.txHashes.length > 0) {
              const boundaryClosedResult =
                await blockProcessor.waitForReplayBoundaryClosed(currentBlock);
              if (!boundaryClosedResult.success) {
                throw boundaryClosedResult.error;
              }
            } else {
              const closeResult = await blockProcessor.closeCurrentBlock(
                currentBlock,
                process,
              );
              if (!closeResult.success) {
                throw closeResult.error;
              }
            }

            if (blockResult.txHashes.length > 0) {
              const closedBlockResult =
                await blockProcessor.validateClosedBlockTransactions(
                  currentBlock,
                  blockResult.txHashes,
                );
              if (!closedBlockResult.success) {
                throw closedBlockResult.error;
              }

              await parallelTransactionProcessor.validateReceipts(
                currentBlock,
                blockResult.txHashes,
                originalStatuses,
              );
            }
            logger.info(
              `⏭️ Transaction-only mode: skipped block hash validation for block ${currentBlock}`,
            );
          } catch (error) {
            if (error instanceof MadaraDownError) {
              logger.warn(
                `🚨 Madara down detected during transaction-only replay at block ${currentBlock}`,
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

              currentBlock = getTransactionOnlyRecoveryBlock(
                recoveryResult.action,
              );
              startTxIndex = 0;
              startTxHash = undefined;
              existingTxHashes =
                recoveryResult.action.type === "continue_block"
                  ? recoveryResult.action.existingTxHashes
                  : [];
              continue;
            }
            throw error;
          }

          incrementBlocksProcessed();
          recordBlockStatus("success");
          throughputTracker.recordBlock(blockResult.txCount);
          process.processedBlocks++;
          updateSyncMetrics(process, process.syncTo, currentBlock);

          const percentComplete = process.isContinuous
            ? "N/A (continuous)"
            : ((process.processedBlocks / process.totalBlocks!) * 100).toFixed(
                2,
              ) + "%";

          logger.info(
            `✅ Block ${currentBlock} transaction-only replay completed (${process.processedBlocks} blocks processed, ${percentComplete} complete)`,
          );

          currentBlock++;
          startTxIndex = 0;
          startTxHash = undefined;
          continue;
        }

        // Validate block (unless we're continuing with existing txs - block is already set up)
        if (existingTxHashes.length === 0) {
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
        } else {
          logger.info(
            `⏭️ Skipping validation/headers - continuing block with ${existingTxHashes.length} existing txs`,
          );
        }

        // Process block: send transactions (receipt validation happens after closeBlock)
        let blockResult: ProcessBlockResult = { txCount: 0, txHashes: [] };
        try {
          blockResult = await processBlock(
            currentBlock,
            process,
            sourceBlock,
            existingTxHashes,
          );
          // Clear existing tx hashes after successful processing
          existingTxHashes = [];
        } catch (error) {
          if (error instanceof MadaraDownError) {
            // Handle Madara recovery - STATELESS approach
            logger.warn(
              `🚨 Madara down detected during transaction sending at block ${currentBlock}`,
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

            // Handle the recovery action
            const { newBlock, existingTxHashes: recoveredTxHashes } =
              handleRecoveryAction(recoveryResult.action, currentBlock);
            currentBlock = newBlock;
            existingTxHashes = recoveredTxHashes;
            continue;
          } else {
            throw error;
          }
        }

        // Validate all transactions are in PRE_CONFIRMED block before closing
        // (skipped when sequential validation is enabled — each tx was already confirmed)
        if (blockResult.txHashes.length > 0 && !config.sequentialValidation) {
          try {
            const validateTxResult =
              await blockProcessor.validateTransactionsBeforeClose(
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

              const recoveryResult = await blockProcessor.handleBlockRecovery(
                currentBlock,
                process,
              );

              if (!recoveryResult.recovered) {
                throw new Error(
                  `Madara recovery failed at block ${currentBlock}`,
                );
              }

              const { newBlock, existingTxHashes: recoveredTxHashes } =
                handleRecoveryAction(recoveryResult.action, currentBlock);
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
          closeResult = await blockProcessor.closeCurrentBlock(
            currentBlock,
            process,
          );
          if (!closeResult.success) {
            throw closeResult.error;
          }
        } catch (error) {
          if (error instanceof MadaraDownError) {
            // Handle Madara recovery during closeBlock - STATELESS approach
            logger.warn(
              `🚨 Madara down detected during closeBlock at block ${currentBlock}`,
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

            // Handle the recovery action
            const { newBlock, existingTxHashes: recoveredTxHashes } =
              handleRecoveryAction(recoveryResult.action, currentBlock);
            currentBlock = newBlock;
            existingTxHashes = recoveredTxHashes;
            continue;
          }
          throw error;
        }

        // Validate receipts AFTER block is closed
        if (blockResult.txHashes.length > 0) {
          try {
            await parallelTransactionProcessor.validateReceipts(
              currentBlock,
              blockResult.txHashes,
            );
          } catch (error) {
            if (error instanceof MadaraDownError) {
              // Handle Madara recovery during receipt validation - STATELESS approach
              logger.warn(
                `🚨 Madara down detected during receipt validation at block ${currentBlock}`,
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

              // Handle the recovery action
              const { newBlock, existingTxHashes: recoveredTxHashes } =
                handleRecoveryAction(recoveryResult.action, currentBlock);
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
          verifyResult = await blockProcessor.verifyBlockHash(
            currentBlock,
            process,
          );
          if (!verifyResult.success) {
            throw verifyResult.error;
          }
        } catch (error) {
          if (error instanceof MadaraDownError) {
            // Handle Madara recovery during hash verification - STATELESS approach
            logger.warn(
              `🚨 Madara down detected during hash verification at block ${currentBlock}`,
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

            // Handle the recovery action
            const { newBlock, existingTxHashes: recoveredTxHashes } =
              handleRecoveryAction(recoveryResult.action, currentBlock);
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
        if (error instanceof TransactionReplayFailedError) {
          throw error;
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
      logger.info(`📍 Range: ${process.syncFrom} → ${process.currentBlock}`);
    }
  } catch (error) {
    if (error instanceof TransactionReplayFailedError) {
      process.status = ProcessStatus.PAUSED;
      process.error = error.message;
      process.currentBlock = error.blockNumber;
      process.currentTxIndex = error.txIndex;
      persistence.pauseSync(
        process.syncTo,
        !!process.isContinuous,
        error.message,
        error.blockNumber,
        error.txIndex,
        error.txHash,
      );
      syncStateManager.stopProbe();
      syncStateManager.clearProcess();
      updateActiveSyncProcessCount("sync", false);
      logger.error(`⏸️ Sync process ${process.id} paused at tx cursor:`, error);
      return;
    }

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
      const persistedState = persistence.readState();

      if (persistedState?.status === ProcessStatus.PAUSED) {
        return res.json({
          message: "Sync process paused",
          status: ProcessStatus.PAUSED,
          mode: persistedState.isContinuous ? "continuous" : "fixed",
          progress: {
            endBlock: persistedState.syncTo,
            currentBlock: persistedState.currentBlock,
            currentTxIndex: persistedState.currentTxIndex,
            currentTxHash: persistedState.currentTxHash,
          },
          error: persistedState.error,
          resumeRequest:
            persistedState.currentBlock !== undefined
              ? {
                  startBlock: persistedState.currentBlock,
                  startTxIndex: persistedState.currentTxIndex ?? 0,
                  startTxHash: persistedState.currentTxHash,
                  endBlock: persistedState.syncTo,
                }
              : undefined,
          updatedAt: persistedState.updatedAt,
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
