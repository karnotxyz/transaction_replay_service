import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import logger from "./logger.js";
import { BlockIdentifier, TransactionWithHash, BlockTag } from "starknet";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
import { SyncProcess, ValidationJob } from "./types.js";
import { persistence } from "./persistence.js";
import { syncStateManager } from "./state/index.js";
import { probeManager } from "./probe/index.js";
import { blockProcessor } from "./sync/BlockProcessor.js";
import { parallelTransactionProcessor } from "./sync/TransactionProcessor.js";
import {
  getLatestBlockNumber,
  getOriginalBlockWithTxsAndProofFacts,
} from "./operations/blockOperations.js";
import { HttpStatus, ProcessStatus, ProbeConfig } from "./constants.js";
import { config } from "./config.js";
import {
  incrementBlocksProcessed,
  incrementBackpressureEvents,
  recordBlockStatus,
  recordBackpressureWait,
  updateCurrentBlock,
  updateMaxInflightBlocks,
  updatePipelineFrontier,
  updatePipelineInflightBlocks,
  updateValidationBacklogBlocks,
  updateValidationQueueDepth,
  updateValidatorWorkers,
  updateSyncingNodeBlockNumber,
} from "./telemetry/metrics.js";
import {
  throughputTracker,
  updateSyncMetrics,
  updateActiveSyncProcessCount,
} from "./telemetry/throughput.js";
import { SyncInProgressError, InvalidBlockError } from "./errors/index.js";

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
      }
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
    validationQueueDepth: 0,
    validationBacklogBlocks: 0,
    activeValidatorWorkers: 0,
    validatorWorkerCount: config.validatorWorkerCount,
    maxInflightBlocks: config.maxInflightBlocks,
  };

  syncStateManager.setProcess(newProcess);

  // Save state to file
  persistence.startSync(isContinuous ? "latest" : targetBlock, isContinuous);

  const mode = isContinuous ? "CONTINUOUS (following latest)" : "FIXED";
  logger.info(`🚀 Starting SYNC process ${processId} [${mode}]`);
  logger.info(
    `📊 Range: Block ${startBlock} → ${targetBlock} (${newProcess.totalBlocks} blocks)`
  );
  logger.info(
    `⚡ Mode: PIPELINED producer + validator pool (ordered producer send, validator_workers=${config.validatorWorkerCount}, max_inflight_blocks=${config.maxInflightBlocks})`
  );

  if (isContinuous) {
    logger.info(
      `🔄 Continuous sync enabled - will track new blocks as they arrive`
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
 * Process a single block with ordered transaction sending and pooled receipt validation
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

interface PipelineState {
  validationQueue: AsyncValidationQueue;
  stopRequested: boolean;
  fatalError: Error | null;
  producerFinished: boolean;
  lastEnqueuedBlock: number;
  lastClosedBlock: number;
  lastValidatedBlock: number;
  validationCompletedBlocks: Set<number>;
  activeValidatorWorkers: number;
}

class AsyncValidationQueue {
  private items: ValidationJob[] = [];
  private waiters: Array<(job: ValidationJob | null) => void> = [];
  private closed = false;

  push(job: ValidationJob): void {
    if (this.closed) {
      throw new Error("Validation queue is closed");
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(job);
      return;
    }

    this.items.push(job);
  }

  async shift(): Promise<ValidationJob | null> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }

    if (this.closed) {
      return null;
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!(null);
    }
  }

  size(): number {
    return this.items.length;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortIfStopped(pipeline: PipelineState): void {
  if (pipeline.stopRequested) {
    throw pipeline.fatalError ?? new Error("Sync pipeline stopped");
  }
}

function syncPipelineProgress(
  process: SyncProcess,
  pipeline: PipelineState
): void {
  const queueDepth = pipeline.validationQueue.size();
  const inflightBlocks = Math.max(
    0,
    pipeline.lastEnqueuedBlock - pipeline.lastClosedBlock
  );
  const validationBacklogBlocks = Math.max(
    0,
    pipeline.lastEnqueuedBlock - pipeline.lastValidatedBlock
  );

  process.lastEnqueuedBlock = pipeline.lastEnqueuedBlock;
  process.lastClosedBlock = pipeline.lastClosedBlock;
  process.lastValidatedBlock = pipeline.lastValidatedBlock;
  process.validationQueueDepth = queueDepth;
  process.validationBacklogBlocks = validationBacklogBlocks;
  process.activeValidatorWorkers = pipeline.activeValidatorWorkers;
  process.validatorWorkerCount = config.validatorWorkerCount;
  process.maxInflightBlocks = config.maxInflightBlocks;

  updateValidationQueueDepth(queueDepth);
  updatePipelineInflightBlocks(inflightBlocks);
  updateValidationBacklogBlocks(validationBacklogBlocks);
  updatePipelineFrontier("enqueued", Math.max(0, pipeline.lastEnqueuedBlock));
  updatePipelineFrontier("closed", Math.max(0, pipeline.lastClosedBlock));
  updatePipelineFrontier(
    "validated",
    Math.max(0, pipeline.lastValidatedBlock)
  );
  updateValidatorWorkers(
    config.validatorWorkerCount,
    pipeline.activeValidatorWorkers
  );
  updateMaxInflightBlocks(config.maxInflightBlocks);
}

function advanceValidatedFrontier(
  pipeline: PipelineState,
  blockNumber: number
): number {
  pipeline.validationCompletedBlocks.add(blockNumber);

  while (pipeline.validationCompletedBlocks.has(pipeline.lastValidatedBlock + 1)) {
    const nextBlock = pipeline.lastValidatedBlock + 1;
    pipeline.validationCompletedBlocks.delete(nextBlock);
    pipeline.lastValidatedBlock = nextBlock;
  }

  return pipeline.lastValidatedBlock;
}

function requestPipelineStop(
  pipeline: PipelineState,
  process: SyncProcess,
  error: Error
): void {
  pipeline.stopRequested = true;
  pipeline.fatalError = error;
  process.error = error.message;
  syncPipelineProgress(process, pipeline);
  pipeline.validationQueue.close();
}

async function processBlock(
  blockNumber: number,
  process: SyncProcess,
  pipeline: PipelineState
): Promise<ProcessBlockResult> {
  const blockWithTxs = await getOriginalBlockWithTxsAndProofFacts(blockNumber);

  const transactions = blockWithTxs.transactions as TransactionWithHash[];
  const totalTxCount = transactions.length;
  const canonicalTxHashes = transactions.map((tx) => tx.transaction_hash);

  logger.info(`📦 Block ${blockNumber}: Found ${totalTxCount} transactions`);

  // Configure replay boundary before any transaction from this block is sent.
  if (canonicalTxHashes.length > 0) {
    const boundaryResult = await blockProcessor.setReplayBoundary(
      blockNumber,
      canonicalTxHashes,
      process
    );
    if (!boundaryResult.success) {
      throw boundaryResult.error;
    }
  }

  if (transactions.length === 0) {
    logger.info(`⏭️  Block ${blockNumber} has no transactions, skipping...`);
    return { txCount: 0, txHashes: [] };
  }

  const result = await parallelTransactionProcessor.sendTransactions(
    transactions,
    blockNumber,
    () => pipeline.stopRequested
  );

  return { txCount: totalTxCount, txHashes: result.txHashes };
}

async function waitForBackpressure(
  currentBlock: number,
  pipeline: PipelineState,
  process: SyncProcess
): Promise<void> {
  let logged = false;
  let waitStartedAt: number | null = null;

  while (!pipeline.stopRequested) {
    const inflightBlocks = Math.max(
      0,
      pipeline.lastEnqueuedBlock - pipeline.lastClosedBlock
    );

    if (inflightBlocks < config.maxInflightBlocks) {
      if (waitStartedAt !== null) {
        recordBackpressureWait((Date.now() - waitStartedAt) / 1000);
      }
      if (logged) {
        logger.info(
          `✅ Backpressure released at block ${currentBlock} (closed=${pipeline.lastClosedBlock}, inflight=${inflightBlocks}/${config.maxInflightBlocks})`
        );
      }
      return;
    }

    if (!logged) {
      incrementBackpressureEvents();
      waitStartedAt = Date.now();
      logger.info(
        `⏸️ Backpressure engaged at block ${currentBlock} (closed=${pipeline.lastClosedBlock}, inflight=${inflightBlocks}/${config.maxInflightBlocks})`
      );
      logged = true;
    }

    syncPipelineProgress(process, pipeline);
    await sleep(config.validatorPollIntervalMs);
  }

  if (waitStartedAt !== null) {
    recordBackpressureWait((Date.now() - waitStartedAt) / 1000);
  }

  abortIfStopped(pipeline);
}

async function runProducerLoop(
  process: SyncProcess,
  pipeline: PipelineState
): Promise<void> {
  const mode = process.isContinuous ? "CONTINUOUS" : "FIXED";
  logger.info(
    `Starting producer loop from block ${process.currentBlock} to ${process.syncTo} [${mode}]`
  );

  let currentBlock = process.currentBlock;

  while (process.isContinuous || currentBlock <= process.syncTo) {
    abortIfStopped(pipeline);

    if (process.cancelRequested) {
      logger.info(
        `🛑 Producer stopping after cancellation request at block ${currentBlock}`
      );
      break;
    }

    if (process.isContinuous && currentBlock > process.syncTo) {
      logger.info(
        `⏸️ Producer caught up to target block ${process.syncTo}, waiting for new blocks...`
      );
      await sleep(ProbeConfig.CAUGHT_UP_WAIT_MS);
      continue;
    }

    await waitForBackpressure(currentBlock, pipeline, process);
    abortIfStopped(pipeline);

    process.currentBlock = currentBlock;
    syncPipelineProgress(process, pipeline);
    updateCurrentBlock(currentBlock);

    logger.info(`🚚 PRODUCING Block ${currentBlock}`);

    const headersResult = await blockProcessor.setBlockHeaders(
      currentBlock,
      process
    );
    if (!headersResult.success) {
      throw headersResult.error;
    }

    const blockResult = await processBlock(currentBlock, process, pipeline);

    if (blockResult.txHashes.length === 0) {
      const closeResult = await blockProcessor.closeCurrentBlock(
        currentBlock,
        process
      );
      if (!closeResult.success) {
        throw closeResult.error;
      }
    }

    abortIfStopped(pipeline);

    pipeline.validationQueue.push({
      blockNumber: currentBlock,
      txHashes: blockResult.txHashes,
      txCount: blockResult.txCount,
      requiresBoundaryClose: blockResult.txHashes.length > 0,
    });
    pipeline.lastEnqueuedBlock = currentBlock;
    syncPipelineProgress(process, pipeline);

    logger.info(
      `📥 Enqueued block ${currentBlock} for validation (queue_depth=${pipeline.validationQueue.size()}, txs=${
        blockResult.txCount
      })`
    );

    currentBlock++;
  }

  process.currentBlock = currentBlock;
  pipeline.producerFinished = true;
  pipeline.validationQueue.close();
  syncPipelineProgress(process, pipeline);
}

async function runValidatorLoop(
  process: SyncProcess,
  pipeline: PipelineState,
  workerId: number
): Promise<void> {
  logger.info(
    `Starting validator worker ${workerId}/${config.validatorWorkerCount} with max_inflight_blocks=${config.maxInflightBlocks}`
  );

  while (true) {
    abortIfStopped(pipeline);

    const job = await pipeline.validationQueue.shift();
    if (!job) {
      return;
    }

    pipeline.activeValidatorWorkers++;
    syncPipelineProgress(process, pipeline);

    try {
      logger.info(
        `🔎 VALIDATING Block ${
          job.blockNumber
        } (worker=${workerId}, queue_depth=${pipeline.validationQueue.size()}, active_workers=${pipeline.activeValidatorWorkers})`
      );

      if (job.requiresBoundaryClose) {
        const closeAttempts = Math.ceil(
          config.validatorCloseTimeoutMs / config.validatorPollIntervalMs
        );
        const boundaryWaitResult =
          await blockProcessor.waitForReplayBoundaryClose(
            job.blockNumber,
            process,
            {
              maxAttempts: closeAttempts,
              delayMs: config.validatorPollIntervalMs,
              shouldAbort: () => pipeline.stopRequested,
            }
          );
        if (!boundaryWaitResult.success) {
          throw boundaryWaitResult.error;
        }
      }

      pipeline.lastClosedBlock = Math.max(
        pipeline.lastClosedBlock,
        job.blockNumber
      );
      syncPipelineProgress(process, pipeline);

      if (job.txHashes.length > 0) {
        await parallelTransactionProcessor.validateReceipts(
          job.blockNumber,
          job.txHashes,
          () => pipeline.stopRequested
        );
      }

      const verifyResult = await blockProcessor.verifyBlockHash(
        job.blockNumber,
        process,
        () => pipeline.stopRequested
      );
      if (!verifyResult.success) {
        throw verifyResult.error;
      }

      incrementBlocksProcessed();
      recordBlockStatus("success");
      throughputTracker.recordBlock(job.txCount);
      updateSyncingNodeBlockNumber(job.blockNumber);

      advanceValidatedFrontier(pipeline, job.blockNumber);
      process.processedBlocks++;
      syncPipelineProgress(process, pipeline);

      updateSyncMetrics(process, process.syncTo, pipeline.lastValidatedBlock);

      const percentComplete = process.isContinuous
        ? "N/A (continuous)"
        : ((process.processedBlocks / process.totalBlocks!) * 100).toFixed(2) +
          "%";

      logger.info(
        `✅ Block ${job.blockNumber} validated by worker ${workerId} (${process.processedBlocks} blocks processed, frontier=${pipeline.lastValidatedBlock}, ${percentComplete} complete)`
      );
    } finally {
      pipeline.activeValidatorWorkers = Math.max(
        0,
        pipeline.activeValidatorWorkers - 1
      );
      syncPipelineProgress(process, pipeline);
    }
  }
}

/**
 * Async function to process blocks
 */
async function syncBlocksAsync(process: SyncProcess): Promise<void> {
  try {
    const mode = process.isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `Starting sync from block ${process.currentBlock} to ${process.syncTo} [${mode}]`
    );
    process.lastEnqueuedBlock = process.currentBlock - 1;
    process.lastClosedBlock = process.currentBlock - 1;
    process.lastValidatedBlock = process.currentBlock - 1;
    process.validationQueueDepth = 0;
    process.validationBacklogBlocks = 0;
    process.activeValidatorWorkers = 0;
    process.validatorWorkerCount = config.validatorWorkerCount;
    process.maxInflightBlocks = config.maxInflightBlocks;

    const pipeline: PipelineState = {
      validationQueue: new AsyncValidationQueue(),
      stopRequested: false,
      fatalError: null,
      producerFinished: false,
      lastEnqueuedBlock: process.currentBlock - 1,
      lastClosedBlock: process.currentBlock - 1,
      lastValidatedBlock: process.currentBlock - 1,
      validationCompletedBlocks: new Set<number>(),
      activeValidatorWorkers: 0,
    };

    syncPipelineProgress(process, pipeline);

    logger.info(
      `⚡ Mode: PIPELINED producer + validator pool (validator_workers=${config.validatorWorkerCount}, max_inflight_blocks=${config.maxInflightBlocks}, poll_interval_ms=${config.validatorPollIntervalMs}, receipt_initial_delay_ms=${config.receiptValidationInitialDelayMs})`
    );

    const producerPromise = runProducerLoop(process, pipeline).catch(
      (error) => {
        recordBlockStatus("failed");
        const err = error instanceof Error ? error : new Error(String(error));
        requestPipelineStop(pipeline, process, err);
        throw err;
      }
    );

    const validatorPromises = Array.from(
      { length: config.validatorWorkerCount },
      (_, index) =>
        runValidatorLoop(process, pipeline, index + 1).catch((error) => {
          recordBlockStatus("failed");
          const err = error instanceof Error ? error : new Error(String(error));
          requestPipelineStop(pipeline, process, err);
          throw err;
        })
    );

    const settledResults = await Promise.allSettled([
      producerPromise,
      ...validatorPromises,
    ]);

    const rejected = settledResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (rejected) {
      throw rejected.reason;
    }

    process.endTime = new Date();
    const duration = process.endTime.getTime() - process.startTime.getTime();
    const durationSeconds = (duration / 1000).toFixed(2);

    if (process.cancelRequested) {
      process.status = ProcessStatus.CANCELLED;
      logger.info(`🛑 SYNC CANCELLED`);
    } else if (!process.isContinuous) {
      process.status = ProcessStatus.COMPLETED;
      logger.info(`🎉 SYNC COMPLETED!`);
    }

    persistence.stopSync();
    syncStateManager.stopProbe();
    syncStateManager.clearProcess();
    updateActiveSyncProcessCount("sync", false);

    logger.info(`✅ Process ${process.id} finished successfully`);
    logger.info(
      `📊 Validated ${process.processedBlocks} blocks in ${durationSeconds}s`
    );
    logger.info(
      `📍 Producer stopped at ${process.currentBlock}, last validated block ${process.lastValidatedBlock}`
    );
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
      `🛑 Cancellation requested for sync process ${currentProcess.id} [${mode}]`
    );

    const response: any = {
      message:
        "Sync cancellation requested - producer and validator are stopping",
      processId: currentProcess.id,
      currentBlock: currentProcess.currentBlock,
      note: "Already-enqueued blocks will continue validating until shutdown completes",
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
      pipeline: {
        lastEnqueuedBlock: currentProcess.lastEnqueuedBlock,
        lastClosedBlock: currentProcess.lastClosedBlock,
        lastValidatedBlock: currentProcess.lastValidatedBlock,
        validationQueueDepth: currentProcess.validationQueueDepth ?? 0,
        validationBacklogBlocks:
          currentProcess.validationBacklogBlocks ?? 0,
        activeValidatorWorkers:
          currentProcess.activeValidatorWorkers ?? 0,
        validatorWorkerCount:
          currentProcess.validatorWorkerCount ?? config.validatorWorkerCount,
        maxInflightBlocks:
          currentProcess.maxInflightBlocks ?? config.maxInflightBlocks,
        inflightBlocks: Math.max(
          0,
          (currentProcess.lastEnqueuedBlock ??
            currentProcess.currentBlock - 1) -
            (currentProcess.lastClosedBlock ?? currentProcess.currentBlock - 1)
        ),
        fullyValidatedInflightBlocks: Math.max(
          0,
          (currentProcess.lastEnqueuedBlock ??
            currentProcess.currentBlock - 1) -
            (currentProcess.lastValidatedBlock ??
              currentProcess.currentBlock - 1)
        ),
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
