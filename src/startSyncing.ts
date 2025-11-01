import dotenv from "dotenv";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import { v4 as uuidv4 } from "uuid";

import { SyncBounds, SyncProcess } from "./types.js";

import logger from "./logger.js";

// In-memory registry of running sync processes
// This is used for cancellation and status tracking while the pod is alive
// Redis is only used for crash recovery/restart scenarios
export let currentProcess: SyncProcess | null = null;
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
import {
  closeBlock,
  getBlock,
  getLatestBlockNumber,
  getPreConfirmedBlock,
  matchBlockHash,
  setCustomHeader,
} from "./utils.js";
import { BlockTag, BlockIdentifier, BlockWithTxHashes } from "starknet";
import { persistence } from "./persistence.js";
import { syncBlock, validateBlock } from "./syncing.js";

// 🆕 Probe state management
let probeInterval: NodeJS.Timeout | null = null;
const PROBE_INTERVAL_MS = 60 * 1000; // 1 minute
const PROBE_MAX_RETRIES = 5;

// 🆕 Start the probe loop for continuous sync
function startProbeLoop(process: SyncProcess): void {
  if (probeInterval) {
    logger.warn("⚠️  Probe loop already running, skipping start");
    return;
  }

  logger.info("🔍 Starting probe loop for continuous sync (checks every 60s)");

  probeInterval = setInterval(async () => {
    try {
      await probeForNewBlocks(process);
    } catch (error) {
      logger.error("❌ Probe loop error:", error);
    }
  }, PROBE_INTERVAL_MS);
}

// 🆕 Stop the probe loop
function stopProbeLoop(): void {
  if (probeInterval) {
    clearInterval(probeInterval);
    probeInterval = null;
    logger.info("🛑 Probe loop stopped");
  }
}

// 🆕 Probe function to check for new blocks with exponential backoff retry
async function probeForNewBlocks(process: SyncProcess): Promise<void> {
  if (!process.isContinuous) {
    logger.debug("Skipping probe - not a continuous sync");
    return;
  }

  let retryCount = 0;
  let lastError: any = null;

  while (retryCount < PROBE_MAX_RETRIES) {
    try {
      const latestBlock = await getLatestBlockNumber(originalProvider_v9);

      if (latestBlock > process.syncTo) {
        const oldTarget = process.syncTo;
        const newBlocks = latestBlock - oldTarget;

        // Update in-memory process
        process.syncTo = latestBlock;

        // Update Redis
        await persistence.updateSyncTarget(process.id, latestBlock);

        logger.info(
          `📈 Target updated: ${oldTarget} → ${latestBlock} (${newBlocks} new blocks detected)`,
        );
      } else {
        logger.debug(
          `🔍 Probe: No new blocks (latest: ${latestBlock}, target: ${process.syncTo})`,
        );
      }

      // Success - exit retry loop
      return;
    } catch (error) {
      lastError = error;
      retryCount++;

      if (retryCount < PROBE_MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        const delay = Math.pow(2, retryCount) * 1000;
        logger.warn(
          `⚠️  Probe failed (attempt ${retryCount}/${PROBE_MAX_RETRIES}), retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries failed
  logger.error(
    `❌ Probe failed after ${PROBE_MAX_RETRIES} attempts. Last error:`,
    lastError,
  );
  logger.warn(
    "⚠️  Continuing with current target, will retry on next probe cycle",
  );
}

export async function find_syncing_bounds(
  end_block: BlockTag | number,
): Promise<SyncBounds> {
  // Get the PRE_CONFIRMED block from syncing node (pending block equivalent)
  const syncing_node_pre_confirmed_block: BlockWithTxHashes = await getBlock(
    syncingProvider_v9,
    BlockTag.PRE_CONFIRMED,
  );

  const Y = syncing_node_pre_confirmed_block.transactions.length; // Transactions in pending/pre-confirmed block
  const N = syncing_node_pre_confirmed_block.block_number!; // Current block being built

  // Get the latest block from original node
  const original_node_latest_block: BlockWithTxHashes = await getBlock(
    originalProvider_v9,
    BlockTag.LATEST,
  );

  const original_node_latest_block_number =
    original_node_latest_block.block_number!;

  // Determine the target end block (T)
  let T: number;
  if (typeof end_block === "number") {
    T = end_block;
  } else if (end_block === BlockTag.LATEST) {
    T = original_node_latest_block_number;
  } else if (
    end_block === BlockTag.PRE_CONFIRMED ||
    end_block === BlockTag.L1_ACCEPTED
  ) {
    T = original_node_latest_block_number;
  } else {
    throw new Error(`Unsupported end_block tag: ${end_block}`);
  }

  logger.info(`📊 Syncing node state: block=${N}, transactions=${Y}`);
  logger.info(
    `📊 Original node latest block: ${original_node_latest_block_number}`,
  );
  logger.info(`📊 Target end block: ${T}`);

  // Decision Matrix
  let syncFrom: number;
  let startTxIndex: number;

  // Case C: Pending block AFTER target range (N > T)
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

  // Case B: Pending block AT OR BEFORE target (N <= T)
  logger.info(`✅ Case B: Syncing node is at or before target (${N} <= ${T})`);

  // Sub-case B1: Empty pending block (Y = 0)
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

  // Get the original block to compare
  const original_block: BlockWithTxHashes = await getBlock(
    originalProvider_v9,
    N,
  );
  const X = original_block.transactions.length;

  logger.info(`📊 Original block ${N} has ${X} transactions`);

  // Sub-case B4: ERROR - More transactions in pending than original (Y > X)
  if (Y > X) {
    const errorMsg = `🚨 CRITICAL ERROR: Syncing node block ${N} has ${Y} txs but original has only ${X}!`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Sub-case B3: All transactions sent (Y = X)
  if (Y === X) {
    logger.info(
      `✅ Sub-case B3: Block ${N} is COMPLETE (${Y}/${X} transactions)`,
    );
    logger.info(
      `🔒 Block ${N} needs to be closed, then continue from ${N + 1}`,
    );

    // The block is complete but not closed yet
    // We should close it and start from the next block
    return {
      syncFrom: N,
      syncTo: T,
      startTxIndex: X, // This will trigger block close in sync logic
      needsBlockClose: true,
      alreadyComplete: false,
      message: `Block ${N} complete (${X}/${X} txs) - will close and continue from ${N + 1} to ${T}`,
    };
  }

  // Sub-case B2: Partial transactions sent (0 < Y < X)
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

function get_target_block(end_block: BlockIdentifier): BlockTag | number {
  // Convert BlockIdentifier to acceptable type
  let targetBlock: number | BlockTag;

  if (end_block === null) {
    targetBlock = BlockTag.LATEST;
  } else if (typeof end_block === "number") {
    targetBlock = end_block;
  } else if (typeof end_block === "string") {
    // Check if it's a valid BlockTag
    if (Object.values(BlockTag).includes(end_block as BlockTag)) {
      targetBlock = end_block as BlockTag;
    } else {
      // Try to parse as hex string or decimal string
      const parsed = end_block.startsWith("0x")
        ? parseInt(end_block, 16)
        : parseInt(end_block, 10);

      if (isNaN(parsed)) {
        throw new Error(`Invalid block identifier: ${end_block}`);
      }
      targetBlock = parsed;
    }
  } else if (typeof end_block === "bigint") {
    targetBlock = Number(end_block);
    if (!Number.isSafeInteger(targetBlock)) {
      throw new Error(
        `Block number ${end_block} is too large to convert safely`,
      );
    }
  } else {
    // Handle other BigNumberish types
    try {
      targetBlock = Number(end_block);
      if (isNaN(targetBlock)) {
        throw new Error(`Cannot convert ${end_block} to number`);
      }
    } catch (error) {
      throw new Error(`Invalid block identifier type: ${typeof end_block}`);
    }
  }
  return targetBlock;
}

export async function start_sync(end_block: BlockIdentifier) {
  // Check if sync is already in progress (check in-memory, NOT Redis)
  // Redis just stores metadata, actual running state is in-memory
  // Don't check Redis here - that's what causes the issue!
  if (currentProcess && currentProcess.status === "running") {
    const error = new Error(
      `Sync already in progress. Process ID: ${currentProcess.id}, Current block: ${currentProcess.currentBlock}, Target: ${currentProcess.syncTo}`,
    ) as any;
    error.code = "SYNC_IN_PROGRESS";
    error.details = {
      processId: currentProcess.id,
      currentBlock: currentProcess.currentBlock,
      currentTxIndex: currentProcess.currentTxIndex,
      syncFrom: currentProcess.syncFrom,
      syncTo: currentProcess.syncTo,
      isContinuous: currentProcess.isContinuous || false,
    };
    throw error;
  }

  let targetBlock = get_target_block(end_block);

  // 🆕 Detect continuous sync mode
  const isContinuous =
    end_block === BlockTag.LATEST ||
    end_block === "latest" ||
    end_block === null;

  // Get sync bounds using pending block analysis
  const bounds = await find_syncing_bounds(targetBlock);

  // Check if sync is already complete
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

  // Save to Redis (with continuous flag)
  await persistence.saveSyncProcess(
    processId,
    bounds.syncFrom,
    bounds.syncTo,
    isContinuous,
    isContinuous ? bounds.syncTo : undefined, // Store original target
  );

  const newProcess: SyncProcess = {
    id: processId,
    status: "running",
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

  // Add to in-memory registry for cancellation and status tracking
  currentProcess = newProcess;

  const syncMode = isContinuous ? "CONTINUOUS (following latest)" : "FIXED";
  logger.info(`🚀 Starting sync process ${processId} [${syncMode}]`);
  logger.info(`📊 ${bounds.message}`);

  if (isContinuous) {
    logger.info(
      `🔄 Continuous sync enabled - will track new blocks as they arrive`,
    );
    logger.info(`📍 Initial target: block ${bounds.syncTo}`);
  }

  // 🆕 Start probe loop for continuous sync
  if (isContinuous) {
    startProbeLoop(newProcess);
  }

  // Start sync process asynchronously
  syncBlocksAsync(newProcess).catch(async (error) => {
    logger.error(`❌ Sync process ${processId} failed:`, error);

    // Stop probe loop on failure
    if (newProcess.isContinuous) {
      stopProbeLoop();
    }

    // Remove from in-memory registry
    currentProcess = null;

    // Update Redis status to failed
    try {
      await persistence.updateStatus(processId, "failed");
    } catch (err) {
      logger.error(`Failed to update Redis status: ${err}`);
    }
  });

  // Return success response
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

// Helper function to get current process from Redis
export async function getCurrentProcess(): Promise<SyncProcess | null> {
  const activeProcess = await persistence.getMostRecentActiveProcess();

  if (!activeProcess) {
    return null;
  }

  // Convert stored process to SyncProcess format
  const isContinuous = activeProcess.isContinuous === "true";
  const originalTarget = activeProcess.originalTarget
    ? parseInt(activeProcess.originalTarget)
    : undefined;

  return {
    id: activeProcess.processId,
    status: activeProcess.status as any,
    syncFrom: activeProcess.syncFrom,
    syncTo: activeProcess.syncTo,
    currentBlock: activeProcess.syncFrom, // We don't track this anymore
    currentTxIndex: 0, // We don't track this anymore
    totalBlocks: isContinuous
      ? null
      : activeProcess.syncTo - activeProcess.syncFrom + 1,
    processedBlocks: 0, // We don't track this anymore
    startTime: new Date(activeProcess.createdAt),
    cancelRequested: false,
    isContinuous,
    originalTarget,
  };
}

// Async sync function with cancellation support and continuous sync
export async function syncBlocksAsync(process: SyncProcess): Promise<void> {
  try {
    const mode = process.isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `Starting async sync process ${process.id} from block ${process.syncFrom} to ${process.syncTo} [${mode}]`,
    );

    let currentBlock = process.currentBlock; // Start from where we left off (or syncFrom)

    // 🆕 Continuous sync loop - never exits naturally
    while (process.isContinuous || currentBlock <= process.syncTo) {
      // Check for cancellation at block level
      if (process.cancelRequested && !process.completeCurrentBlock) {
        await persistence.updateStatus(process.id, "cancelled");
        stopProbeLoop();
        currentProcess = null;
        logger.info(
          `Sync process ${process.id} cancelled immediately at block ${currentBlock}, tx index ${process.currentTxIndex}`,
        );
        return;
      }

      // If completing current block, check if we should stop after this block
      if (
        process.cancelRequested &&
        process.completeCurrentBlock &&
        currentBlock > process.currentBlock
      ) {
        await persistence.updateStatus(process.id, "cancelled");
        stopProbeLoop();
        currentProcess = null;
        logger.info(
          `Sync process ${process.id} cancelled after completing block ${process.currentBlock}`,
        );
        return;
      }

      // 🆕 For continuous sync: if caught up, wait for new blocks
      if (process.isContinuous && currentBlock > process.syncTo) {
        logger.info(
          `⏸️  Caught up to target block ${process.syncTo}, waiting for new blocks...`,
        );
        logger.info(`🔍 Probe will check for new blocks every 60 seconds`);

        // Wait for 5 seconds, then check again
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue; // Go back to loop start and check again
      }

      process.currentBlock = currentBlock;
      logger.info(`Syncing block ${currentBlock}`);

      try {
        await validateBlock(currentBlock);
        await setCustomHeader(currentBlock);
        const blockCompleted = await syncBlock(currentBlock, process);

        // If block was cancelled mid-way, don't close it
        if (!blockCompleted) {
          logger.info(
            `Block ${currentBlock} partially processed - cancellation requested`,
          );
          stopProbeLoop();
          return;
        }

        // Only close block if it was fully processed
        await closeBlock();
        await matchBlockHash(currentBlock);

        process.processedBlocks++;
        process.currentTxIndex = 0; // Reset for next block

        // Update Redis timestamp periodically (every block)
        await persistence.updateLastChecked(process.id);

        logger.info(`Block ${currentBlock} completed successfully`);

        // If we completed current block due to cancellation, stop here
        if (process.cancelRequested && process.completeCurrentBlock) {
          await persistence.updateStatus(process.id, "cancelled");
          stopProbeLoop();
          currentProcess = null;
          logger.info(
            `Sync process ${process.id} cancelled after completing current block ${currentBlock}`,
          );
          return;
        }

        // Move to next block
        currentBlock++;
      } catch (error) {
        await persistence.updateStatus(process.id, "failed");
        stopProbeLoop();
        logger.error(
          `Failed to process block ${currentBlock} in process ${process.id}:`,
          error,
        );
        throw error;
      }
    }

    // 🆕 This only executes for non-continuous sync (fixed range completed)
    if (!process.isContinuous) {
      await persistence.updateStatus(process.id, "completed");
      stopProbeLoop();
      currentProcess = null;
      logger.info(
        `✅ Sync process ${process.id} completed successfully (${process.syncFrom} → ${process.syncTo})`,
      );
    }
  } catch (error) {
    await persistence.updateStatus(process.id, "failed");
    stopProbeLoop();
    currentProcess = null;
    logger.error(`❌ Sync process ${process.id} failed:`, error);
    throw error;
  }
}
