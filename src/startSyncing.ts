import logger from "./logger.js";
import { v4 as uuidv4 } from "uuid";
import { SyncBounds, SyncProcess } from "./types.js";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
import {
  getLatestBlockNumber,
  getBlock,
  getBlockWithTxs,
} from "./operations/blockOperations.js";
import { BlockTag, BlockIdentifier, BlockWithTxHashes } from "starknet";
import { persistence } from "./persistence.js";
import { syncStateManager } from "./state/index.js";
import { probeManager } from "./probe/index.js";
import { blockProcessor } from "./sync/BlockProcessor.js";
import { ProcessStatus } from "./constants.js";
import {
  SyncInProgressError,
  InvalidBlockError,
} from "./errors/index.js";
import { syncBlock } from "./syncing.js";

/**
 * Find syncing bounds by analyzing pending block state
 */
export async function findSyncingBounds(
  endBlock: BlockTag | number,
): Promise<SyncBounds> {
  // Get the PRE_CONFIRMED block from syncing node
  const syncingNodePreConfirmedBlock: BlockWithTxHashes = await getBlock(
    syncingProvider_v9,
    BlockTag.PRE_CONFIRMED,
  );

  const Y = syncingNodePreConfirmedBlock.transactions.length;
  const N = syncingNodePreConfirmedBlock.block_number!;

  // Get the latest block from original node
  const originalNodeLatestBlock: BlockWithTxHashes = await getBlock(
    originalProvider_v9,
    BlockTag.LATEST,
  );

  const originalNodeLatestBlockNumber = originalNodeLatestBlock.block_number!;

  // Determine target end block (T)
  let T: number;
  if (typeof endBlock === "number") {
    T = endBlock;
  } else if (endBlock === BlockTag.LATEST) {
    T = originalNodeLatestBlockNumber;
  } else if (
    endBlock === BlockTag.PRE_CONFIRMED ||
    endBlock === BlockTag.L1_ACCEPTED
  ) {
    T = originalNodeLatestBlockNumber;
  } else {
    throw new InvalidBlockError(`Unsupported end_block tag: ${endBlock}`);
  }

  logger.info(`📊 Syncing node state: block=${N}, transactions=${Y}`);
  logger.info(
    `📊 Original node latest block: ${originalNodeLatestBlockNumber}`,
  );
  logger.info(`📊 Target end block: ${T}`);

  // Decision logic
  let syncFrom: number;
  let startTxIndex: number;

  // Case C: Already past target
  if (N > T) {
    logger.info(`✅ Case C: Syncing node is AHEAD of target (${N} > ${T})`);
    logger.info(`🎉 Sync is already complete or beyond target!`);
    return {
      syncFrom: T,
      syncTo: T,
      startTxIndex: 0,
      alreadyComplete: true,
      message: `Syncing node at block ${N} is already past target block ${T}`,
    };
  }

  // Case B: At or before target
  logger.info(`✅ Case B: Syncing node is at or before target (${N} <= ${T})`);

  // Sub-case B1: Empty pending block
  if (Y === 0) {
    logger.info(`📭 Sub-case B1: Pending block ${N} is EMPTY`);
    syncFrom = N;
    startTxIndex = 0;

    return {
      syncFrom,
      syncTo: T,
      startTxIndex,
      alreadyComplete: false,
      message: `Starting fresh from block ${N} to ${T}`,
    };
  }

  // Sub-case B2/B3/B4: Pending block has transactions
  logger.info(
    `📦 Pending block ${N} has ${Y} transactions - checking original block`,
  );

  const originalBlock: BlockWithTxHashes = await getBlock(
    originalProvider_v9,
    N,
  );
  const X = originalBlock.transactions.length;

  logger.info(`📊 Original block ${N} has ${X} transactions`);

  // Sub-case B4: ERROR - More transactions in pending than original
  if (Y > X) {
    const errorMsg = `🚨 CRITICAL ERROR: Syncing node block ${N} has ${Y} txs but original has only ${X}!`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Sub-case B3: All transactions sent
  if (Y === X) {
    logger.info(
      `✅ Sub-case B3: Block ${N} is COMPLETE (${Y}/${X} transactions)`,
    );
    logger.info(
      `🔒 Block ${N} needs to be closed, then continue from ${N + 1}`,
    );

    return {
      syncFrom: N,
      syncTo: T,
      startTxIndex: X,
      needsBlockClose: true,
      alreadyComplete: false,
      message: `Block ${N} complete (${X}/${X} txs) - will close and continue from ${N + 1} to ${T}`,
    };
  }

  // Sub-case B2: Partial transactions sent
  logger.info(
    `⏸️  Sub-case B2: Block ${N} is PARTIAL (${Y}/${X} transactions)`,
  );
  logger.info(`▶️  Resume from block ${N}, transaction ${Y}`);

  return {
    syncFrom: N,
    syncTo: T,
    startTxIndex: Y,
    alreadyComplete: false,
    message: `Resuming block ${N} from transaction ${Y} (${Y}/${X} done) to block ${T}`,
  };
}

/**
 * Convert BlockIdentifier to BlockTag or number
 */
function getTargetBlock(endBlock: BlockIdentifier): BlockTag | number {
  if (endBlock === null) {
    return BlockTag.LATEST;
  }

  if (typeof endBlock === "number") {
    return endBlock;
  }

  if (typeof endBlock === "string") {
    // Check if it's a valid BlockTag
    if (Object.values(BlockTag).includes(endBlock as BlockTag)) {
      return endBlock as BlockTag;
    }

    // Try to parse as hex or decimal
    const parsed = endBlock.startsWith("0x")
      ? parseInt(endBlock, 16)
      : parseInt(endBlock, 10);

    if (isNaN(parsed)) {
      throw new InvalidBlockError(`Invalid block identifier: ${endBlock}`);
    }
    return parsed;
  }

  if (typeof endBlock === "bigint") {
    const num = Number(endBlock);
    if (!Number.isSafeInteger(num)) {
      throw new InvalidBlockError(
        `Block number ${endBlock} is too large to convert safely`,
      );
    }
    return num;
  }

  // Handle other BigNumberish types
  try {
    const num = Number(endBlock);
    if (isNaN(num)) {
      throw new InvalidBlockError(`Cannot convert ${endBlock} to number`);
    }
    return num;
  } catch (error) {
    throw new InvalidBlockError(
      `Invalid block identifier type: ${typeof endBlock}`,
    );
  }
}

/**
 * Start a sync process (legacy sequential sync - not used in main app)
 * @deprecated Use start_snap_sync from snapSync.ts instead
 */
export async function start_sync(endBlock: BlockIdentifier) {
  // Check if sync is already in progress
  if (syncStateManager.isSequentialSyncRunning()) {
    const currentProcess = syncStateManager.getSequentialProcess()!;
    throw new SyncInProgressError(
      `Sync already in progress. Process ID: ${currentProcess.id}, Current block: ${currentProcess.currentBlock}, Target: ${currentProcess.syncTo}`,
      {
        processId: currentProcess.id,
        currentBlock: currentProcess.currentBlock,
        currentTxIndex: currentProcess.currentTxIndex,
        syncFrom: currentProcess.syncFrom,
        syncTo: currentProcess.syncTo,
        isContinuous: currentProcess.isContinuous || false,
      },
    );
  }

  const targetBlock = getTargetBlock(endBlock);

  // Detect continuous sync mode
  const isContinuous =
    endBlock === BlockTag.LATEST || endBlock === "latest" || endBlock === null;

  // Get sync bounds
  const bounds = await findSyncingBounds(targetBlock);

  // Check if already complete
  if (bounds.alreadyComplete) {
    logger.info(`✅ ${bounds.message}`);
    return {
      success: true,
      alreadyComplete: true,
      message: bounds.message,
      syncFrom: bounds.syncFrom,
      syncTo: bounds.syncTo,
    };
  }

  // Create new process
  const processId = uuidv4();

  // Save state to file
  persistence.startSync(isContinuous ? "latest" : bounds.syncTo, isContinuous);

  const newProcess: SyncProcess = {
    id: processId,
    status: ProcessStatus.RUNNING,
    syncFrom: bounds.syncFrom,
    syncTo: bounds.syncTo,
    currentBlock: bounds.syncFrom,
    currentTxIndex: bounds.startTxIndex,
    totalBlocks: isContinuous ? null : bounds.syncTo - bounds.syncFrom + 1,
    processedBlocks: 0,
    startTime: new Date(),
    cancelRequested: false,
    isContinuous,
    originalTarget: isContinuous ? bounds.syncTo : undefined,
  };

  // Register with state manager
  syncStateManager.setSequentialProcess(newProcess);

  const syncMode = isContinuous ? "CONTINUOUS (following latest)" : "FIXED";
  logger.info(`🚀 Starting sync process ${processId} [${syncMode}]`);
  logger.info(`📊 ${bounds.message}`);

  if (isContinuous) {
    logger.info(
      `🔄 Continuous sync enabled - will track new blocks as they arrive`,
    );
    logger.info(`📍 Initial target: block ${bounds.syncTo}`);
  }

  // Start probe loop for continuous sync
  if (isContinuous) {
    const probeInterval = probeManager.createProbeInterval(newProcess);
    syncStateManager.setSequentialProbeInterval(probeInterval);
  }

  // Start sync process asynchronously
  syncBlocksAsync(newProcess).catch(async (error) => {
    logger.error(`❌ Sync process ${processId} failed:`, error);

    if (newProcess.isContinuous) {
      syncStateManager.stopSequentialProbe();
    }

    syncStateManager.clearSequentialProcess();
    persistence.stopSync();
  });

  return {
    success: true,
    processId,
    message: bounds.message,
    syncFrom: bounds.syncFrom,
    syncTo: bounds.syncTo,
    startTxIndex: bounds.startTxIndex,
    estimatedBlocks: newProcess.totalBlocks,
    isContinuous,
  };
}

/**
 * Async function to sync blocks
 */
async function syncBlocksAsync(process: SyncProcess): Promise<void> {
  try {
    const mode = process.isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `Starting async sync process ${process.id} from block ${process.syncFrom} to ${process.syncTo} [${mode}]`,
    );

    let currentBlock = process.currentBlock;

    while (process.isContinuous || currentBlock <= process.syncTo) {
      // Check for cancellation at block level
      if (process.cancelRequested && !process.completeCurrentBlock) {
        process.status = ProcessStatus.CANCELLED;
        syncStateManager.stopSequentialProbe();
        syncStateManager.clearSequentialProcess();
        persistence.stopSync();
        logger.info(
          `Sync process ${process.id} cancelled immediately at block ${currentBlock}, tx index ${process.currentTxIndex}`,
        );
        return;
      }

      if (
        process.cancelRequested &&
        process.completeCurrentBlock &&
        currentBlock > process.currentBlock
      ) {
        process.status = ProcessStatus.CANCELLED;
        syncStateManager.stopSequentialProbe();
        syncStateManager.clearSequentialProcess();
        persistence.stopSync();
        logger.info(
          `Sync process ${process.id} cancelled after completing block ${process.currentBlock}`,
        );
        return;
      }

      // For continuous sync: if caught up, wait for new blocks
      if (process.isContinuous && currentBlock > process.syncTo) {
        logger.info(
          `⏸️  Caught up to target block ${process.syncTo}, waiting for new blocks...`,
        );
        logger.info(`🔍 Probe will check for new blocks every 60 seconds`);

        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      process.currentBlock = currentBlock;
      logger.info(`Syncing block ${currentBlock}`);

      try {
        // Process the block using the refactored syncBlock
        const syncResult = await syncBlock(currentBlock, process);

        if (!syncResult.completed) {
          if (syncResult.needsRestart) {
            logger.info(
              `🔄 Block ${currentBlock} needs restart - retrying from beginning`,
            );
            continue;
          }

          // Cancellation
          logger.info(
            `Block ${currentBlock} partially processed - cancellation requested`,
          );
          syncStateManager.stopSequentialProbe();
          return;
        }

        // Close block
        const closeResult = await blockProcessor.closeCurrentBlock(
          currentBlock,
          process,
        );
        if (!closeResult.success) {
          throw closeResult.error!;
        }

        // Match block hash
        const verifyResult = await blockProcessor.verifyBlockHash(
          currentBlock,
          process,
        );
        if (!verifyResult.success) {
          throw verifyResult.error!;
        }

        process.processedBlocks++;
        process.currentTxIndex = 0;

        logger.info(`✅ Block ${currentBlock} completed successfully`);

        if (process.cancelRequested && process.completeCurrentBlock) {
          process.status = ProcessStatus.CANCELLED;
          syncStateManager.stopSequentialProbe();
          syncStateManager.clearSequentialProcess();
          persistence.stopSync();
          logger.info(
            `Sync process ${process.id} cancelled after completing current block ${currentBlock}`,
          );
          return;
        }

        currentBlock++;
      } catch (error) {
        process.status = ProcessStatus.FAILED;
        syncStateManager.stopSequentialProbe();
        persistence.stopSync();
        logger.error(
          `Failed to process block ${currentBlock} in process ${process.id}:`,
          error,
        );
        throw error;
      }
    }

    if (!process.isContinuous) {
      process.status = ProcessStatus.COMPLETED;
      syncStateManager.stopSequentialProbe();
      syncStateManager.clearSequentialProcess();
      persistence.stopSync();
      logger.info(
        `✅ Sync process ${process.id} completed successfully (${process.syncFrom} → ${process.syncTo})`,
      );
    }
  } catch (error) {
    process.status = ProcessStatus.FAILED;
    syncStateManager.stopSequentialProbe();
    syncStateManager.clearSequentialProcess();
    persistence.stopSync();
    logger.error(`❌ Sync process ${process.id} failed:`, error);
    throw error;
  }
}

/**
 * Get current process from state manager
 */
export async function getCurrentProcess(): Promise<SyncProcess | null> {
  return syncStateManager.getSequentialProcess();
}

// Export for backwards compatibility
export { syncStateManager as currentProcess };
