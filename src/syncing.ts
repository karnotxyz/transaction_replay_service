import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import logger from "./logger.js";
import {
  processTx
} from "./transactions/index.js";
import {
  getLatestBlockNumber,
  closeBlock,
  validateTransactionReceipt,
  matchBlockHash
} from "./utils.js";
import { sendAlert } from "./sns.js";
import { originalProvider, syncingProvider } from "./providers.js";
import { BlockIdentifier, TransactionWithHash, TXN_HASH } from "starknet";

// Process state management
interface SyncProcess {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  syncFrom: number;
  syncTo: number;
  currentBlock: number;
  currentTxIndex: number;
  totalBlocks: number;
  processedBlocks: number;
  startTime: Date;
  endTime?: Date;
  error?: string;
  cancelRequested: boolean;
  completeCurrentBlock?: boolean; // New field for completion mode
}

interface SyncRequest {
  syncFrom: number;
  syncTo: number;
  startTxIndex?: number; // Starting transaction index
  endTxIndex?: number;   // Ending transaction index (optional)
}

// Global process state - in-memory only
let currentProcess: SyncProcess | null = null;
const processHistory: Map<string, SyncProcess> = new Map();

// Enhanced sync endpoint
export const syncEndpoint = async (req: Request, res: Response) => {
  try {
    const { syncFrom, syncTo, startTxIndex = 0, endTxIndex }: SyncRequest = req.body;

    // Validate request
    if (!syncFrom || !syncTo) {
      return res.status(400).json({
        error: "Missing required fields: syncFrom and syncTo"
      });
    }

    if (syncFrom > syncTo) {
      return res.status(400).json({
        error: "syncFrom cannot be greater than syncTo"
      });
    }

    // Check if sync is already in progress
    if (currentProcess && currentProcess.status === 'running') {
      return res.status(409).json({
        error: "Sync already in progress",
        currentProcessId: currentProcess.id,
        currentStatus: {
          processId: currentProcess.id,
          status: currentProcess.status,
          currentBlock: currentProcess.currentBlock,
          currentTxIndex: currentProcess.currentTxIndex,
          progress: `${currentProcess.processedBlocks}/${currentProcess.totalBlocks} blocks`
        }
      });
    }

    // Validate sync bounds and transaction indices
    try {
      await validateSyncBounds(syncFrom, syncTo, startTxIndex, endTxIndex);
    } catch (error) {
      return res.status(400).json({
        error: `Invalid sync bounds: ${error}`
      });
    }

    // Create new process
    const processId = uuidv4();
    const newProcess: SyncProcess = {
      id: processId,
      status: 'running',
      syncFrom,
      syncTo,
      currentBlock: syncFrom,
      currentTxIndex: startTxIndex,
      totalBlocks: syncTo - syncFrom + 1,
      processedBlocks: 0,
      startTime: new Date(),
      cancelRequested: false
    };

    currentProcess = newProcess;
    processHistory.set(processId, newProcess);

    // Start sync process asynchronously
    syncBlocksAsync(newProcess).catch(error => {
      logger.error(`Sync process ${processId} failed:`, error);
      newProcess.status = 'failed';
      newProcess.error = error;
      newProcess.endTime = new Date();
    });

    // Immediate response
    res.status(202).json({
      message: "Sync process started successfully",
      processId: processId,
      status: {
        syncFrom,
        syncTo,
        startTxIndex,
        endTxIndex,
        estimatedBlocks: newProcess.totalBlocks
      }
    });

  } catch (error) {
    logger.error("Error starting sync process:", error);
    res.status(500).json({
      error: `Failed to start sync: ${error}`
    });
  }
};

// Get sync status endpoint
export const getSyncStatus = async (req: Request, res: Response) => {
  try {
    const processId = req.params.processId || req.query.processId as string;

    if (processId) {
      const process = processHistory.get(processId);
      if (!process) {
        return res.status(404).json({
          error: "Process not found"
        });
      }

      return res.json({
        processId: process.id,
        status: process.status,
        progress: {
          currentBlock: process.currentBlock,
          currentTxIndex: process.currentTxIndex,
          processedBlocks: process.processedBlocks,
          totalBlocks: process.totalBlocks,
          percentage: Math.round((process.processedBlocks / process.totalBlocks) * 100)
        },
        timing: {
          startTime: process.startTime,
          endTime: process.endTime,
          duration: process.endTime ?
            process.endTime.getTime() - process.startTime.getTime() :
            Date.now() - process.startTime.getTime()
        },
        error: process.error
      });
    }

    // Return current process if no specific ID requested
    if (currentProcess) {
      return res.json({
        processId: currentProcess.id,
        status: currentProcess.status,
        progress: {
          currentBlock: currentProcess.currentBlock,
          currentTxIndex: currentProcess.currentTxIndex,
          processedBlocks: currentProcess.processedBlocks,
          totalBlocks: currentProcess.totalBlocks,
          percentage: Math.round((currentProcess.processedBlocks / currentProcess.totalBlocks) * 100)
        }
      });
    }

    res.json({
      message: "No sync process currently running"
    });

  } catch (error) {
    res.status(500).json({
      error: `Failed to get status: ${error}`
    });
  }
};

// Cancel sync endpoint
export const cancelSync = async (req: Request, res: Response) => {
  try {
    const processId = req.params.processId || req.body.processId;
    const completeCurrentBlock = req.body.complete_current_block || false;

    if (processId && processId !== currentProcess?.id) {
      return res.status(404).json({
        error: "Process not found or not currently running"
      });
    }

    if (!currentProcess || currentProcess.status !== 'running') {
      return res.status(400).json({
        error: "No sync process currently running"
      });
    }

    // Mark for cancellation
    currentProcess.cancelRequested = true;
    currentProcess.completeCurrentBlock = completeCurrentBlock;

    res.json({
      message: completeCurrentBlock ?
        "Cancellation requested - will complete current block and stop" :
        "Cancellation requested - will stop immediately after current transaction",
      processId: currentProcess.id,
      cancellationMode: completeCurrentBlock ? "complete_current_block" : "immediate",
      currentBlock: currentProcess.currentBlock,
      currentTxIndex: currentProcess.currentTxIndex,
      note: completeCurrentBlock ?
        "Process will complete all transactions in current block before stopping" :
        "Process will stop after completing current transaction",
      resumeInfo: {
        message: "To resume from this point, use these parameters in your next sync request:",
        syncFrom: currentProcess.currentBlock + 1,
        startTxIndex: completeCurrentBlock ? 0 : currentProcess.currentTxIndex
      }
    });

  } catch (error) {
    res.status(500).json({
      error: `Failed to cancel sync: ${error}`
    });
  }
};

// Get process history
export const getProcessHistory = async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const processes = Array.from(processHistory.values())
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);

    res.json({
      processes: processes.map(p => ({
        processId: p.id,
        status: p.status,
        syncFrom: p.syncFrom,
        syncTo: p.syncTo,
        currentBlock: p.currentBlock,
        currentTxIndex: p.currentTxIndex,
        progress: `${p.processedBlocks}/${p.totalBlocks} blocks`,
        startTime: p.startTime,
        endTime: p.endTime,
        duration: p.endTime ?
          p.endTime.getTime() - p.startTime.getTime() :
          null,
        error: p.error
      }))
    });
  } catch (error) {
    res.status(500).json({
      error: `Failed to get process history: ${error}`
    });
  }
};

// Validate sync bounds and transaction indices
async function validateSyncBounds(
  syncFrom: number,
  syncTo: number,
  startTxIndex: number = 0,
  endTxIndex?: number
): Promise<void> {
  // Validate block range
  const latestBlockNumber = await getLatestBlockNumber(syncingProvider);

  if (syncFrom < 0 || syncTo < 0) {
    throw new Error("Block numbers cannot be negative");
  }

  // if (syncFrom > latestBlockNumber || syncTo > latestBlockNumber) {
  //   throw new Error(`Block numbers cannot exceed latest block ${latestBlockNumber}`);
  // }

  // Validate transaction indices for the starting block
  try {
    const startBlock = await originalProvider.getBlockWithTxs(syncFrom);

    if (startTxIndex < 0 || startTxIndex >= startBlock.transactions.length) {
      throw new Error(`Invalid startTxIndex ${startTxIndex}. Block ${syncFrom} has ${startBlock.transactions.length} transactions`);
    }

    if (endTxIndex !== undefined) {
      if (endTxIndex < startTxIndex || endTxIndex >= startBlock.transactions.length) {
        throw new Error(`Invalid endTxIndex ${endTxIndex}. Must be >= ${startTxIndex} and < ${startBlock.transactions.length}`);
      }
    }
  } catch (error) {
    throw new Error(`Failed to validate transaction bounds: ${error}`);
  }
}

// Async sync function with cancellation support
async function syncBlocksAsync(process: SyncProcess): Promise<void> {
  try {
    logger.info(`Starting async sync process ${process.id} from block ${process.syncFrom} to ${process.syncTo}`);

    for (let currentBlock = process.syncFrom; currentBlock <= process.syncTo; currentBlock++) {
      // Check for cancellation at block level
      if (process.cancelRequested && !process.completeCurrentBlock) {
        process.status = 'cancelled';
        process.endTime = new Date();
        logger.info(`Sync process ${process.id} cancelled immediately at block ${currentBlock}, tx index ${process.currentTxIndex}`);
        return;
      }

      // If completing current block, check if we should stop after this block
      if (process.cancelRequested && process.completeCurrentBlock && currentBlock > process.currentBlock) {
        process.status = 'cancelled';
        process.endTime = new Date();
        logger.info(`Sync process ${process.id} cancelled after completing block ${process.currentBlock}`);
        return;
      }

      process.currentBlock = currentBlock;
      logger.info(`Syncing block ${currentBlock} (Process: ${process.id})...`);

      try {
        await validateBlock(currentBlock);
        const blockCompleted = await syncBlock(currentBlock, process);

        // If block was cancelled mid-way, don't close it
        if (!blockCompleted) {
          logger.info(`Block ${currentBlock} partially processed - cancellation requested`);
          return;
        }

        // Only close block if it was fully processed
        await closeBlock();
        await matchBlockHash(currentBlock);

        process.processedBlocks++;
        process.currentTxIndex = 0; // Reset for next block

        logger.info(`Block ${currentBlock} completed successfully (Process: ${process.id})`);

        // If we completed current block due to cancellation, stop here
        if (process.cancelRequested && process.completeCurrentBlock) {
          process.status = 'cancelled';
          process.endTime = new Date();
          logger.info(`Sync process ${process.id} cancelled after completing current block ${currentBlock}`);
          return;
        }

      } catch (error) {
        process.status = 'failed';
        // process.error = error;
        console.log("Error happened: ", error);
        process.endTime = new Date();
        logger.error(`Failed to process block ${currentBlock} in process ${process.id}:`, error);
        throw error;
      }
    }

    process.status = 'completed';
    process.endTime = new Date();
    logger.info(`Sync process ${process.id} completed successfully`);

  } catch (error) {
    process.status = 'failed';
    // process.error = error;
    console.log("Error happened: ", error);
    process.endTime = new Date();
    throw error;
  } finally {
    // Clear current process if it's this one
    if (currentProcess?.id === process.id) {
      currentProcess = null;
    }
  }
}

// Enhanced sync block with transaction index support
async function syncBlock(block_no: number, process: SyncProcess): Promise<boolean> {
  const blockWithTxs = await originalProvider.getBlockWithTxs(block_no);

  logger.info(
    `Found ${blockWithTxs.transactions.length} transactions to process in block ${block_no} (Process: ${process.id})`
  );

  if (blockWithTxs.transactions.length === 0) {
    const errorMsg = `No transactions to process in block ${block_no}`;
    logger.error(errorMsg);
    await sendAlert("[SYNCING_SERVICE] No transactions to process", errorMsg);
    throw new Error("No transactions to process in block");
  }

  const transactionHashes: string[] = [];
  const startIndex = block_no === process.syncFrom ? process.currentTxIndex : 0;

  for (let i = startIndex; i < blockWithTxs.transactions.length; i++) {
    // Check for cancellation before each transaction
    if (process.cancelRequested && !process.completeCurrentBlock) {
      process.currentTxIndex = i;
      process.status = 'cancelled';
      process.endTime = new Date();
      logger.info(`Immediate cancellation detected at block ${block_no}, transaction ${i}. Last processed tx index: ${i - 1}`);
      return false; // Block not completed
    }

    const tx: TransactionWithHash = blockWithTxs.transactions[i];
    process.currentTxIndex = i;

    console.log(`Processing transaction ${i}/${blockWithTxs.transactions.length - 1} - ${tx.transaction_hash} (Process: ${process.id})`);

    try {
      const tx_hash = await processTx(tx, block_no);

      if (i === startIndex) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        await validateTransactionReceipt(syncingProvider, tx_hash, {
          useExponentialBackoff: true
        });
      } else {
        await validateTransactionReceipt(syncingProvider, tx_hash);
      }

      transactionHashes.push(tx_hash);

      // Update the last processed transaction index
      process.currentTxIndex = i;

    } catch (err) {
      logger.error(`Error processing transaction ${tx.transaction_hash}:`, err);
      await sendAlert(
        "[SYNCING_SERVICE] Error processing transaction",
        `Error processing transaction ${tx.transaction_hash}, error: ${err}`
      );
      throw err;
    }
  }

  // If we reach here, the block was completed successfully
  logger.info(`All transactions processed successfully for block ${block_no}`);
  return true; // Block completed
}

// Block validation (unchanged)
async function validateBlock(currentBlock: number): Promise<void> {
  const maxRetries = 5;
  let retryCount = 0;
  let blockValidated = false;

  while (retryCount <= maxRetries && !blockValidated) {
    try {
      const latestBlockNumber = await getLatestBlockNumber(syncingProvider);
      console.log(`Latest block number check (attempt ${retryCount + 1}): ${latestBlockNumber}, expecting: ${currentBlock - 1}`);

      if (latestBlockNumber + 1 === currentBlock) {
        blockValidated = true;
        console.log(`Block ${currentBlock} validation successful`);
      } else {
        throw new Error(`Sync block ${currentBlock} is not 1 + ${latestBlockNumber}`);
      }
    } catch (error) {
      retryCount++;
      console.warn(`Block validation attempt ${retryCount} failed for block ${currentBlock}:`, error);

      if (retryCount > maxRetries) {
        throw new Error(`Failed to validate block ${currentBlock} after ${maxRetries + 1} attempts. Latest error: ${error}`);
      }

      const delay = Math.pow(2, retryCount) * 1000;
      console.log(`Retrying block ${currentBlock} validation in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Graceful shutdown handler
export const gracefulShutdown = async (signal: string): Promise<void> => {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

  if (currentProcess && currentProcess.status === 'running') {
    logger.info(`Gracefully shutting down sync process ${currentProcess.id}`);
    currentProcess.cancelRequested = true;

    // Wait a bit for the current transaction to complete, but not too long
    console.log('Waiting for current transaction to complete...');
    await Promise.race([
      new Promise(resolve => setTimeout(resolve, 3000)), // Max 3 seconds wait
      new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (!currentProcess || currentProcess.status !== 'running') {
            clearInterval(checkInterval);
            resolve(undefined);
          }
        }, 100);
      })
    ]);
  }

  console.log('Shutting down...');
  process.exit(0);
};

// Process cleanup on application exit
let shutdownInProgress = false;

process.on('SIGINT', async () => {
  if (shutdownInProgress) {
    console.log('\nForce exiting...');
    process.exit(1);
  }
  shutdownInProgress = true;
  await gracefulShutdown('SIGINT');
});

process.on('SIGTERM', async () => {
  if (shutdownInProgress) {
    process.exit(1);
  }
  shutdownInProgress = true;
  await gracefulShutdown('SIGTERM');
});
