import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import logger from "./logger.js";
import { BlockIdentifier, TransactionWithHash, BlockTag } from "starknet";
import {
  originalProvider,
  syncingProvider,
  supportsProofFacts,
} from "./providers.js";
import { SyncProcess, ValidationJob } from "./types.js";
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
  getExecutionBoxStatus,
  setCustomHeader,
  closeBlock,
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
import { assertExecutionBoxHealthy } from "./sync/pipelineGuards.js";
import { getMempoolTransactionSuffix } from "./sync/mempoolCursor.js";

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
        currentTxIndex: currentProcess.currentTxIndex,
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
  const txMode = config.replayBlockRpcEnabled
    ? `SINGLE RPC block replay${config.shouldValidateBlockHash ? " with hash validation" : " without hash validation"}`
    : config.isMempoolReplay
      ? `PIPELINED mempool submission (max_inflight_source_blocks=${config.transactionOnlyMaxInflightBlocks}), natural Madara block closure, transaction status validation`
      : config.isTransactionOnlyReplay
        ? `${
            config.transactionOnlyMaxInflightBlocks > 1
              ? `PIPELINED boundary replay (max_inflight_blocks=${config.transactionOnlyMaxInflightBlocks})`
              : "SERIAL boundary replay"
          }${
            config.shouldValidateBlockHash
              ? " with hash validation"
              : " without hash validation"
          }`
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

interface TransactionOnlyPipelineState {
  queue: AsyncValidationQueue;
  stopRequested: boolean;
  fatalError: Error | null;
  lastEnqueuedBlock: number;
  lastClosedBlock: number;
  lastValidatedBlock: number;
  executionBoxEpoch?: number;
}

class AsyncValidationQueue {
  private readonly jobs: ValidationJob[] = [];
  private readonly waiters: Array<(job: ValidationJob | null) => void> = [];
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
    this.jobs.push(job);
  }

  async shift(): Promise<ValidationJob | null> {
    const job = this.jobs.shift();
    if (job) {
      return job;
    }
    if (this.closed) {
      return null;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
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
    return this.jobs.length;
  }
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function abortPipelineIfStopped(pipeline: TransactionOnlyPipelineState): void {
  if (pipeline.stopRequested) {
    throw pipeline.fatalError ?? new Error("Transaction-only pipeline stopped");
  }
}

function updatePipelineProgress(
  process: SyncProcess,
  pipeline: TransactionOnlyPipelineState,
): void {
  process.lastEnqueuedBlock = pipeline.lastEnqueuedBlock;
  process.lastClosedBlock = pipeline.lastClosedBlock;
  process.lastValidatedBlock = pipeline.lastValidatedBlock;
  process.validationQueueDepth = pipeline.queue.size();
  process.comparatorBacklogBlocks = Math.max(
    0,
    pipeline.lastEnqueuedBlock - pipeline.lastClosedBlock,
  );
  process.maxInflightBlocks = config.transactionOnlyMaxInflightBlocks;
}

function stopPipeline(
  process: SyncProcess,
  pipeline: TransactionOnlyPipelineState,
  error: unknown,
): Error {
  const fatalError = error instanceof Error ? error : new Error(String(error));
  pipeline.stopRequested = true;
  pipeline.fatalError = fatalError;
  process.error = fatalError.message;
  pipeline.queue.close();
  updatePipelineProgress(process, pipeline);
  return fatalError;
}

async function waitForPipelineCapacity(
  blockNumber: number,
  process: SyncProcess,
  pipeline: TransactionOnlyPipelineState,
): Promise<void> {
  let logged = false;
  while (!pipeline.stopRequested) {
    const inflightBlocks = Math.max(
      0,
      pipeline.lastEnqueuedBlock - pipeline.lastClosedBlock,
    );
    if (inflightBlocks < config.transactionOnlyMaxInflightBlocks) {
      if (logged) {
        logger.info(
          `✅ Comparator backlog released for block ${blockNumber}: ${inflightBlocks}/${config.transactionOnlyMaxInflightBlocks}`,
        );
      }
      return;
    }
    if (!logged) {
      logger.info(
        `⏸️ Comparator backlog full before block ${blockNumber}: ${inflightBlocks}/${config.transactionOnlyMaxInflightBlocks}`,
      );
      logged = true;
    }
    updatePipelineProgress(process, pipeline);
    await sleep(config.transactionOnlyBoundaryPollIntervalMs);
  }
  abortPipelineIfStopped(pipeline);
}

async function sendPipelinedTransactionOnlyBlock(
  blockNumber: number,
  pipeline: TransactionOnlyPipelineState,
): Promise<ValidationJob> {
  const sourceBlock = supportsProofFacts()
    ? await getOriginalBlockWithTxsAndProofFacts(blockNumber)
    : ((await getBlockWithTxs(
        originalProvider,
        blockNumber,
      )) as SourceBlockWithTxs);
  assertSupportedBlockVersion(blockNumber, sourceBlock.starknet_version);

  const transactions = sourceBlock.transactions as TransactionWithHash[];
  const txHashes = transactions.map((tx) => tx.transaction_hash);
  const expectedStatuses = await getOriginalReceiptStatusMap(
    blockNumber,
    transactions,
  );

  logger.info(
    `🚚 PIPELINE sending block ${blockNumber} with ${transactions.length} transactions`,
  );
  await setCustomHeader(blockNumber);

  if (txHashes.length === 0) {
    await closeBlock();
    return {
      blockNumber,
      txHashes,
      txCount: 0,
      expectedStatuses,
      requiresBoundaryClose: false,
    };
  }

  const boundaryResult = await blockProcessor.setTransactionOnlyReplayBoundary(
    blockNumber,
    txHashes,
  );
  if (!boundaryResult.success) {
    throw boundaryResult.error;
  }

  const sendResult = await parallelTransactionProcessor.sendTransactions(
    transactions,
    blockNumber,
    false,
    0,
    () => pipeline.stopRequested,
  );

  const pollInterval = config.transactionOnlyBoundaryPollIntervalMs;
  const maxRetries = Math.ceil(
    config.transactionOnlyBoundaryTimeoutMs / pollInterval,
  );
  const boundaryMet = await blockProcessor.waitForReplayBoundaryMet(
    blockNumber,
    txHashes.length,
    maxRetries,
    pollInterval,
    () => pipeline.stopRequested,
  );
  if (!boundaryMet.success) {
    throw boundaryMet.error;
  }

  return {
    blockNumber,
    txHashes: sendResult.txHashes,
    txCount: transactions.length,
    expectedStatuses,
    requiresBoundaryClose: true,
  };
}

async function runTransactionOnlyProducer(
  process: SyncProcess,
  pipeline: TransactionOnlyPipelineState,
): Promise<void> {
  let currentBlock = process.currentBlock;
  let caughtUpLogged = false;

  while (process.isContinuous || currentBlock <= process.syncTo) {
    abortPipelineIfStopped(pipeline);
    if (process.cancelRequested) {
      logger.info(
        `🛑 Transaction-only pipeline producer stopping before block ${currentBlock}`,
      );
      break;
    }
    if (process.isContinuous && currentBlock > process.syncTo) {
      if (!caughtUpLogged) {
        logger.info(
          `⏸️ Pipeline caught up to source target ${process.syncTo}; waiting for new blocks`,
        );
        caughtUpLogged = true;
      }
      await sleep(ProbeConfig.CAUGHT_UP_WAIT_MS);
      continue;
    }
    caughtUpLogged = false;

    await waitForPipelineCapacity(currentBlock, process, pipeline);
    abortPipelineIfStopped(pipeline);

    process.currentBlock = currentBlock;
    process.currentTxIndex = 0;
    process.currentTxHash = undefined;
    persistence.updateProgress(currentBlock, 0);
    updateCurrentBlock(currentBlock);

    const job = await sendPipelinedTransactionOnlyBlock(currentBlock, pipeline);
    abortPipelineIfStopped(pipeline);

    pipeline.queue.push(job);
    pipeline.lastEnqueuedBlock = currentBlock;
    currentBlock++;
    process.currentBlock = currentBlock;
    updatePipelineProgress(process, pipeline);

    logger.info(
      `📥 Block ${job.blockNumber} execution complete and queued for comparator/close validation: comparator_backlog=${process.comparatorBacklogBlocks}/${config.transactionOnlyMaxInflightBlocks}, validation_queue=${process.validationQueueDepth}`,
    );
  }

  pipeline.queue.close();
}

async function runTransactionOnlyValidator(
  process: SyncProcess,
  pipeline: TransactionOnlyPipelineState,
): Promise<void> {
  while (true) {
    abortPipelineIfStopped(pipeline);
    const job = await pipeline.queue.shift();
    if (!job) {
      return;
    }

    logger.info(
      `🔎 PIPELINE validating block ${job.blockNumber}: comparator_backlog=${process.comparatorBacklogBlocks}/${config.transactionOnlyMaxInflightBlocks}`,
    );

    if (job.requiresBoundaryClose) {
      const pollInterval = config.transactionOnlyBoundaryPollIntervalMs;
      const closeResult = await blockProcessor.waitForReplayBoundaryClosed(
        job.blockNumber,
        Math.ceil(config.transactionOnlyBoundaryTimeoutMs / pollInterval),
        pollInterval,
        job.txCount,
        () => pipeline.stopRequested,
      );
      if (!closeResult.success) {
        throw closeResult.error;
      }
    }

    if (config.transactionOnlyRequireMixedMode) {
      const executionBoxStatus = await getExecutionBoxStatus();
      assertExecutionBoxHealthy(executionBoxStatus, pipeline.executionBoxEpoch);
    }

    pipeline.lastClosedBlock = job.blockNumber;
    updatePipelineProgress(process, pipeline);

    if (job.txHashes.length > 0) {
      const closedBlockResult =
        await blockProcessor.validateClosedBlockTransactions(
          job.blockNumber,
          job.txHashes,
        );
      if (!closedBlockResult.success) {
        throw closedBlockResult.error;
      }

      await parallelTransactionProcessor.validateReceipts(
        job.blockNumber,
        job.txHashes,
        job.expectedStatuses,
      );
    }

    if (config.shouldValidateBlockHash) {
      const verifyResult = await blockProcessor.verifyBlockHash(
        job.blockNumber,
        process,
      );
      if (!verifyResult.success) {
        throw verifyResult.error;
      }
    }

    incrementBlocksProcessed();
    recordBlockStatus("success");
    throughputTracker.recordBlock(job.txCount);
    process.processedBlocks++;
    pipeline.lastValidatedBlock = job.blockNumber;
    updatePipelineProgress(process, pipeline);
    updateSyncMetrics(process, process.syncTo, job.blockNumber);

    logger.info(
      `✅ PIPELINE block ${job.blockNumber} closed and validated: processed=${process.processedBlocks}, comparator_backlog=${process.comparatorBacklogBlocks}/${config.transactionOnlyMaxInflightBlocks}, validation_queue=${process.validationQueueDepth}`,
    );
  }
}

async function syncTransactionOnlyBlocksPipelined(
  process: SyncProcess,
): Promise<void> {
  if (process.currentTxIndex !== 0 || process.currentTxHash) {
    throw new Error(
      "Pipelined transaction-only replay requires a whole-block start cursor",
    );
  }

  const initialFrontier = process.currentBlock - 1;
  const pipeline: TransactionOnlyPipelineState = {
    queue: new AsyncValidationQueue(),
    stopRequested: false,
    fatalError: null,
    lastEnqueuedBlock: initialFrontier,
    lastClosedBlock: initialFrontier,
    lastValidatedBlock: initialFrontier,
  };

  if (config.transactionOnlyRequireMixedMode) {
    const status = await getExecutionBoxStatus();
    assertExecutionBoxHealthy(status);
    pipeline.executionBoxEpoch = status.reexec_epoch;
  }
  updatePipelineProgress(process, pipeline);

  logger.info(
    `⚡ Transaction-only pipeline active: max_inflight_blocks=${config.transactionOnlyMaxInflightBlocks}, boundary_poll_ms=${config.transactionOnlyBoundaryPollIntervalMs}, boundary_timeout_ms=${config.transactionOnlyBoundaryTimeoutMs}, require_mixed_mode=${config.transactionOnlyRequireMixedMode}, hash_validation=${config.shouldValidateBlockHash}`,
  );

  const producer = runTransactionOnlyProducer(process, pipeline).catch(
    (error) => {
      throw stopPipeline(process, pipeline, error);
    },
  );
  const validator = runTransactionOnlyValidator(process, pipeline).catch(
    (error) => {
      throw stopPipeline(process, pipeline, error);
    },
  );

  const results = await Promise.allSettled([producer, validator]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }

  if (process.cancelRequested) {
    process.status = ProcessStatus.CANCELLED;
  } else if (!process.isContinuous) {
    process.status = ProcessStatus.COMPLETED;
  }
  process.endTime = new Date();
  persistence.stopSync();
  syncStateManager.stopProbe();
  syncStateManager.clearProcess();
  updateActiveSyncProcessCount("sync", false);

  logger.info(
    `✅ Transaction-only pipeline stopped cleanly: validated_through=${pipeline.lastValidatedBlock}, processed_blocks=${process.processedBlocks}`,
  );
}

interface MempoolPipelineState {
  queue: AsyncValidationQueue;
  stopRequested: boolean;
  fatalError: Error | null;
  lastEnqueuedBlock: number;
  lastValidatedBlock: number;
  executionBoxEpoch?: number;
}

function updateMempoolPipelineProgress(
  process: SyncProcess,
  pipeline: MempoolPipelineState,
): void {
  process.lastEnqueuedBlock = pipeline.lastEnqueuedBlock;
  process.lastClosedBlock = pipeline.lastValidatedBlock;
  process.lastValidatedBlock = pipeline.lastValidatedBlock;
  process.validationQueueDepth = pipeline.queue.size();
  process.comparatorBacklogBlocks = Math.max(
    0,
    pipeline.lastEnqueuedBlock - pipeline.lastValidatedBlock,
  );
  process.maxInflightBlocks = config.transactionOnlyMaxInflightBlocks;
}

function stopMempoolPipeline(
  process: SyncProcess,
  pipeline: MempoolPipelineState,
  error: unknown,
): Error {
  const fatalError = error instanceof Error ? error : new Error(String(error));
  pipeline.stopRequested = true;
  if (!pipeline.fatalError) {
    pipeline.fatalError = fatalError;
    logger.error(`Mempool pipeline initiating failure: ${fatalError.message}`);
  }
  process.error = pipeline.fatalError.message;
  pipeline.queue.close();
  updateMempoolPipelineProgress(process, pipeline);
  return pipeline.fatalError;
}

function abortMempoolPipelineIfStopped(pipeline: MempoolPipelineState): void {
  if (pipeline.stopRequested) {
    throw pipeline.fatalError ?? new Error("Mempool pipeline stopped");
  }
}

async function waitForMempoolPipelineCapacity(
  sourceBlockNumber: number,
  process: SyncProcess,
  pipeline: MempoolPipelineState,
): Promise<void> {
  let logged = false;
  while (!pipeline.stopRequested) {
    const inflightBlocks = Math.max(
      0,
      pipeline.lastEnqueuedBlock - pipeline.lastValidatedBlock,
    );
    if (inflightBlocks < config.transactionOnlyMaxInflightBlocks) {
      return;
    }
    if (!logged) {
      logger.info(
        `⏸️ Mempool validation window full before source block ${sourceBlockNumber}: ${inflightBlocks}/${config.transactionOnlyMaxInflightBlocks}`,
      );
      logged = true;
    }
    updateMempoolPipelineProgress(process, pipeline);
    await sleep(config.transactionOnlyBoundaryPollIntervalMs);
  }
  abortMempoolPipelineIfStopped(pipeline);
}

async function sendMempoolSourceBlock(
  sourceBlockNumber: number,
  pipeline: MempoolPipelineState,
  startTxIndex: number,
): Promise<ValidationJob> {
  const sourceBlock = (await getBlockWithTxs(
    originalProvider,
    sourceBlockNumber,
  )) as SourceBlockWithTxs;
  assertSupportedBlockVersion(sourceBlockNumber, sourceBlock.starknet_version);

  const allTransactions = sourceBlock.transactions as TransactionWithHash[];
  const transactions = getMempoolTransactionSuffix(
    allTransactions,
    startTxIndex,
    sourceBlockNumber,
  );
  const expectedStatuses = await getOriginalReceiptStatusMap(
    sourceBlockNumber,
    transactions,
  );

  logger.info(
    `📤 MEMPOOL sending source block ${sourceBlockNumber} from tx index ${startTxIndex} (${transactions.length}/${allTransactions.length} transaction(s)); no custom header, replay boundary, or close-block RPC`,
  );
  const result = await parallelTransactionProcessor.sendTransactions(
    transactions,
    sourceBlockNumber,
    false,
    config.mempoolTransactionIntervalMs,
    () => pipeline.stopRequested,
    "mempool",
  );

  return {
    blockNumber: sourceBlockNumber,
    txHashes: result.txHashes,
    txCount: transactions.length,
    expectedStatuses,
    requiresBoundaryClose: false,
  };
}

async function runMempoolProducer(
  process: SyncProcess,
  pipeline: MempoolPipelineState,
): Promise<void> {
  let sourceBlockNumber = process.currentBlock;
  let startTxIndex = process.currentTxIndex || 0;
  let caughtUpLogged = false;

  while (process.isContinuous || sourceBlockNumber <= process.syncTo) {
    abortMempoolPipelineIfStopped(pipeline);
    if (process.cancelRequested) {
      break;
    }
    if (process.isContinuous && sourceBlockNumber > process.syncTo) {
      if (!caughtUpLogged) {
        logger.info(
          `⏸️ Mempool producer caught up to source target ${process.syncTo}; waiting for new blocks`,
        );
        caughtUpLogged = true;
      }
      await sleep(ProbeConfig.CAUGHT_UP_WAIT_MS);
      continue;
    }
    caughtUpLogged = false;

    await waitForMempoolPipelineCapacity(sourceBlockNumber, process, pipeline);
    abortMempoolPipelineIfStopped(pipeline);

    process.currentBlock = sourceBlockNumber;
    process.currentTxIndex = startTxIndex;
    process.currentTxHash = undefined;
    updateCurrentBlock(sourceBlockNumber);

    const job = await sendMempoolSourceBlock(
      sourceBlockNumber,
      pipeline,
      startTxIndex,
    );
    abortMempoolPipelineIfStopped(pipeline);

    pipeline.queue.push(job);
    pipeline.lastEnqueuedBlock = sourceBlockNumber;
    sourceBlockNumber++;
    startTxIndex = 0;
    process.currentBlock = sourceBlockNumber;
    process.currentTxIndex = 0;
    updateMempoolPipelineProgress(process, pipeline);

    logger.info(
      `📥 MEMPOOL source block ${job.blockNumber} submitted: validation_backlog=${process.comparatorBacklogBlocks}/${config.transactionOnlyMaxInflightBlocks}, validation_queue=${process.validationQueueDepth}`,
    );
  }

  pipeline.queue.close();
}

async function runMempoolValidator(
  process: SyncProcess,
  pipeline: MempoolPipelineState,
): Promise<void> {
  while (true) {
    abortMempoolPipelineIfStopped(pipeline);
    const job = await pipeline.queue.shift();
    if (!job) {
      return;
    }

    await parallelTransactionProcessor.validateMempoolTransactionStatuses(
      job.blockNumber,
      job.txHashes,
      job.expectedStatuses,
    );

    if (config.transactionOnlyRequireMixedMode) {
      const executionBoxStatus = await getExecutionBoxStatus();
      assertExecutionBoxHealthy(executionBoxStatus, pipeline.executionBoxEpoch);
    }

    incrementBlocksProcessed();
    recordBlockStatus("success");
    throughputTracker.recordBlock(job.txCount);
    process.processedBlocks++;
    pipeline.lastValidatedBlock = job.blockNumber;
    persistence.updateProgress(job.blockNumber + 1, 0);
    updateMempoolPipelineProgress(process, pipeline);
    updateSyncMetrics(process, process.syncTo, job.blockNumber);

    logger.info(
      `✅ MEMPOOL source block ${job.blockNumber} fully processed: ${job.txCount} transaction(s) finalized with matching statuses; processed=${process.processedBlocks}, validation_backlog=${process.comparatorBacklogBlocks}/${config.transactionOnlyMaxInflightBlocks}`,
    );
  }
}

async function syncMempoolBlocksPipelined(process: SyncProcess): Promise<void> {
  if (process.currentTxHash) {
    throw new Error("Mempool replay does not support startTxHash");
  }

  const initialFrontier = process.currentBlock - 1;
  const pipeline: MempoolPipelineState = {
    queue: new AsyncValidationQueue(),
    stopRequested: false,
    fatalError: null,
    lastEnqueuedBlock: initialFrontier,
    lastValidatedBlock: initialFrontier,
  };
  if (config.transactionOnlyRequireMixedMode) {
    const status = await getExecutionBoxStatus();
    assertExecutionBoxHealthy(status);
    pipeline.executionBoxEpoch = status.reexec_epoch;
  }
  updateMempoolPipelineProgress(process, pipeline);

  logger.info(
    `⚡ MEMPOOL replay active: transaction_interval_ms=${config.mempoolTransactionIntervalMs}, max_inflight_source_blocks=${config.transactionOnlyMaxInflightBlocks}, require_mixed_mode=${config.transactionOnlyRequireMixedMode}; Madara owns block packing and closure; block hash validation disabled`,
  );

  const producer = runMempoolProducer(process, pipeline).catch((error) => {
    throw stopMempoolPipeline(process, pipeline, error);
  });
  const validator = runMempoolValidator(process, pipeline).catch((error) => {
    throw stopMempoolPipeline(process, pipeline, error);
  });

  const results = await Promise.allSettled([producer, validator]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }

  if (process.cancelRequested) {
    process.status = ProcessStatus.CANCELLED;
  } else if (!process.isContinuous) {
    process.status = ProcessStatus.COMPLETED;
  }
  process.endTime = new Date();
  persistence.stopSync();
  syncStateManager.stopProbe();
  syncStateManager.clearProcess();
  updateActiveSyncProcessCount("sync", false);

  logger.info(
    `✅ MEMPOOL replay stopped cleanly: validated_through_source_block=${pipeline.lastValidatedBlock}, processed_source_blocks=${process.processedBlocks}`,
  );
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

    if (config.isMempoolReplay) {
      await syncMempoolBlocksPipelined(process);
      return;
    }

    if (
      config.isTransactionOnlyReplay &&
      config.transactionOnlyMaxInflightBlocks > 1
    ) {
      await syncTransactionOnlyBlocksPipelined(process);
      return;
    }

    let currentBlock = process.currentBlock;
    let startTxIndex = process.currentTxIndex || 0;
    let startTxHash = process.currentTxHash;
    // Track existing tx hashes for recovery scenarios (continue_block action)
    let existingTxHashes: string[] = [];
    const finalizeSuccessfulBlock = (txCount: number) => {
      incrementBlocksProcessed();
      recordBlockStatus("success");
      throughputTracker.recordBlock(txCount);
      process.processedBlocks++;
      updateSyncMetrics(process, process.syncTo, currentBlock);

      const percentComplete = process.isContinuous
        ? "N/A (continuous)"
        : ((process.processedBlocks / process.totalBlocks!) * 100).toFixed(
          2,
        ) + "%";

      logger.info(
        `✅ Block ${currentBlock} completed (${process.processedBlocks} blocks processed, ${percentComplete} complete)`,
      );
    };

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
            if (config.shouldValidateBlockHash) {
              const verifyResult = await blockProcessor.verifyBlockHash(
                currentBlock,
                process,
              );
              if (!verifyResult.success) {
                throw verifyResult.error;
              }
            } else {
              logger.info(
                `⏭️ Transaction-only mode: skipped block hash validation for block ${currentBlock}`,
              );
            }
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

          if (config.replayBlockRpcEnabled) {
            let replayResult;
            try {
              replayResult = await blockProcessor.replayBlock(
                currentBlock,
                sourceBlock,
                process,
              );
              if (!replayResult.success) {
                throw replayResult.error;
              }
            } catch (error) {
              if (error instanceof MadaraDownError) {
                logger.warn(
                  `🚨 Madara down detected during replayBlock at block ${currentBlock}`,
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

            finalizeSuccessfulBlock(sourceBlock.transactions.length);
            currentBlock++;
            continue;
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

        // Verify block hash when requested. Header-driven replay can intentionally
        // preserve source timestamps while accepting a different local hash.
        if (config.shouldValidateBlockHash) {
          try {
            const verifyResult = await blockProcessor.verifyBlockHash(
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
        } else {
          logger.info(
            `⏭️ Skipped block hash validation for block ${currentBlock}`,
          );
        }

        finalizeSuccessfulBlock(blockResult.txCount);
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

    if (
      config.isMempoolReplay ||
      (config.isTransactionOnlyReplay &&
        config.transactionOnlyMaxInflightBlocks > 1)
    ) {
      process.status = ProcessStatus.PAUSED;
      process.error = error instanceof Error ? error.message : String(error);
      const resumeBlock = config.isMempoolReplay
        ? (process.lastValidatedBlock ?? process.syncFrom - 1) + 1
        : undefined;
      persistence.pauseSync(
        process.isContinuous ? "latest" : process.syncTo,
        !!process.isContinuous,
        process.error,
        resumeBlock,
        resumeBlock === undefined ? undefined : 0,
      );
      syncStateManager.stopProbe();
      syncStateManager.clearProcess();
      updateActiveSyncProcessCount("sync", false);
      logger.error(
        `⏸️ ${
          config.isMempoolReplay ? "Mempool" : "Transaction-only"
        } pipeline stopped on first failure: ${process.error}`,
      );
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

    if (currentProcess.maxInflightBlocks !== undefined) {
      response.pipeline = {
        maxInflightBlocks: currentProcess.maxInflightBlocks,
        lastEnqueuedBlock: currentProcess.lastEnqueuedBlock,
        lastClosedBlock: currentProcess.lastClosedBlock,
        lastValidatedBlock: currentProcess.lastValidatedBlock,
        comparatorBacklogBlocks: currentProcess.comparatorBacklogBlocks,
        validationQueueDepth: currentProcess.validationQueueDepth,
      };
    }

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
