import { Request, Response } from "express";
import logger from "./logger.js";
import { processTx } from "./transactions/index.js";
import {
  getLatestBlockNumber,
  getLatestBlockNumberWithRetry,
  closeBlock,
  validateTransactionReceipt,
  matchBlockHash,
  setCustomHeader,
  getBlockWithTxsWithRetry,
} from "./utils.js";
import { BlockIdentifier, TransactionWithHash, TXN_HASH } from "starknet";
import { start_sync, currentProcess } from "./startSyncing.js";
import { SyncProcess, SyncRequest } from "./types.js";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";

export const syncEndpoint = async (req: Request, res: Response) => {
  try {
    const { endBlock }: { endBlock: BlockIdentifier } = req.body;

    // Validate request
    if (!endBlock && endBlock !== 0) {
      return res.status(400).json({
        error: "Missing required field: endBlock",
      });
    }

    // Call start_sync - it handles all the logic
    const result = await start_sync(endBlock);

    // Handle already complete case
    if (result.alreadyComplete) {
      return res.status(200).json({
        message: result.message,
        alreadyComplete: true,
        syncFrom: result.syncFrom,
        syncTo: result.syncTo,
      });
    }

    // Success - sync started
    return res.status(202).json({
      message: "Sync process started successfully",
      processId: result.processId,
      status: {
        syncFrom: result.syncFrom,
        syncTo: result.syncTo,
        startTxIndex: result.startTxIndex,
        estimatedBlocks: result.estimatedBlocks,
      },
    });
  } catch (error: any) {
    // Handle specific error codes
    if (error.code === "SYNC_IN_PROGRESS") {
      return res.status(409).json({
        error: error.message,
        ...error.details,
      });
    }

    if (
      error.code === "INVALID_BLOCK_NUMBER" ||
      error.code === "INVALID_BLOCK_IDENTIFIER" ||
      error.code === "INVALID_BLOCK_TYPE" ||
      error.code === "BLOCK_NUMBER_TOO_LARGE"
    ) {
      return res.status(400).json({
        error: error.message,
        code: error.code,
      });
    }

    // Unknown error
    logger.error("Error starting sync process:", error);
    return res.status(500).json({
      error: `Failed to start sync: ${error.message || error}`,
    });
  }
};

// Cancel sync endpoint
export const cancelSync = async (req: Request, res: Response) => {
  try {
    const processId = req.params.processId;
    const { complete_current_block } = req.body;

    // Validate processId
    if (!processId) {
      return res.status(400).json({
        error: "Missing required parameter: processId",
      });
    }

    // Validate complete_current_block
    if (typeof complete_current_block !== "boolean") {
      return res.status(400).json({
        error:
          "Missing or invalid required field: complete_current_block (must be boolean)",
      });
    }

    // Find the process in the running processes map
    const process = currentProcess!;

    if (!process) {
      return res.status(404).json({
        error: "Process not found or not currently running",
        processId,
      });
    }

    // Check if already cancelled or completed
    if (process.status !== "running") {
      return res.status(400).json({
        error: `Process is not running (current status: ${process.status})`,
        processId,
        status: process.status,
      });
    }

    // Set cancellation flags
    process.cancelRequested = true;
    process.completeCurrentBlock = complete_current_block;

    logger.info(
      `🛑 Cancellation requested for process ${processId} (complete_current_block: ${complete_current_block})`,
    );

    // Return success response
    return res.json({
      message: complete_current_block
        ? "Cancellation requested - will complete current block and stop"
        : "Cancellation requested - will stop immediately after current transaction",
      processId: process.id,
      cancellationMode: complete_current_block
        ? "complete_current_block"
        : "immediate",
      currentBlock: process.currentBlock,
      currentTxIndex: process.currentTxIndex,
      note: complete_current_block
        ? "Process will complete all transactions in current block before stopping"
        : "Process will stop after completing current transaction",
      resumeInfo: {
        message:
          "To resume from this point, use these parameters in your next sync request:",
        syncFrom: process.currentBlock,
        startTxIndex: complete_current_block ? 0 : process.currentTxIndex,
      },
    });
  } catch (error: any) {
    logger.error("Error cancelling sync process:", error);
    return res.status(500).json({
      error: `Failed to cancel sync: ${error.message || error}`,
    });
  }
};

// Cancel current sync endpoint (without processId)
export const cancelCurrentSync = async (req: Request, res: Response) => {
  try {
    const { complete_current_block } = req.body;

    // Validate complete_current_block
    if (typeof complete_current_block !== "boolean") {
      return res.status(400).json({
        error:
          "Missing or invalid required field: complete_current_block (must be boolean)",
      });
    }

    // Check if there's a running process
    if (!currentProcess) {
      return res.status(404).json({
        error: "No sync process currently running",
      });
    }

    // Check if already cancelled or completed
    if (currentProcess.status !== "running") {
      return res.status(400).json({
        error: `Process is not running (current status: ${currentProcess.status})`,
        processId: currentProcess.id,
        status: currentProcess.status,
      });
    }

    // Set cancellation flags
    currentProcess.cancelRequested = true;
    currentProcess.completeCurrentBlock = complete_current_block;

    logger.info(
      `🛑 Cancellation requested for current process ${currentProcess.id} (complete_current_block: ${complete_current_block})`,
    );

    // Return success response
    return res.json({
      message: complete_current_block
        ? "Cancellation requested - will complete current block and stop"
        : "Cancellation requested - will stop immediately after current transaction",
      processId: currentProcess.id,
      cancellationMode: complete_current_block
        ? "complete_current_block"
        : "immediate",
      currentBlock: currentProcess.currentBlock,
      currentTxIndex: currentProcess.currentTxIndex,
      note: complete_current_block
        ? "Process will complete all transactions in current block before stopping"
        : "Process will stop after completing current transaction",
      resumeInfo: {
        message:
          "To resume from this point, use these parameters in your next sync request:",
        syncFrom: currentProcess.currentBlock,
        startTxIndex: complete_current_block
          ? 0
          : currentProcess.currentTxIndex,
      },
    });
  } catch (error: any) {
    logger.error("Error cancelling current sync process:", error);
    return res.status(500).json({
      error: `Failed to cancel sync: ${error.message || error}`,
    });
  }
};

// Enhanced sync block with transaction index support
export async function syncBlock(
  block_no: number,
  process: SyncProcess,
): Promise<boolean> {
  const blockWithTxs = await getBlockWithTxsWithRetry(
    originalProvider_v9,
    block_no,
  );

  logger.info(
    `Found ${blockWithTxs.transactions.length} transactions to process in block ${block_no}`,
  );

  // if (blockWithTxs.transactions.length === 0) {
  //   const errorMsg = `No transactions to process in block ${block_no}`;
  //   logger.error(errorMsg);
  //   throw new Error("No transactions to process in block");
  // }

  const transactionHashes: string[] = [];
  const startIndex = block_no === process.syncFrom ? process.currentTxIndex : 0;

  for (let i = startIndex; i < blockWithTxs.transactions.length; i++) {
    // Check for cancellation before each transaction
    if (process.cancelRequested && !process.completeCurrentBlock) {
      process.currentTxIndex = i;
      process.status = "cancelled";
      process.endTime = new Date();
      logger.info(
        `Immediate cancellation detected at block ${block_no}, transaction ${i}. Last processed tx index: ${
          i - 1
        }`,
      );
      return false; // Block not completed
    }

    const tx: TransactionWithHash = blockWithTxs.transactions[i];
    process.currentTxIndex = i;

    logger.info(
      `Processing transaction ${i}/${blockWithTxs.transactions.length - 1} - ${
        tx.transaction_hash
      }`,
    );

    try {
      const tx_hash = await processTx(tx, block_no);

      await new Promise((resolve) => setTimeout(resolve, 100));

      if (i === startIndex) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await validateTransactionReceipt(syncingProvider_v9, tx_hash, {
          useExponentialBackoff: true,
        });
      } else {
        await validateTransactionReceipt(syncingProvider_v9, tx_hash, {
          maxRetries: 2000, // 150 * 100ms = 15 seconds
        });
      }

      transactionHashes.push(tx_hash);

      // Update the last processed transaction index
      process.currentTxIndex = i;
    } catch (err) {
      // logger.error(`Error processing transaction ${tx.transaction_hash}:`, err);
      // await sendAlert(
      //   "[SYNCING_SERVICE] Error processing transaction",
      //   `Error processing transaction ${tx.transaction_hash}, error: ${err}`
      // );
      throw err;
    }
  }

  // If we reach here, the block was completed successfully
  logger.info(`All transactions processed successfully for block ${block_no}`);
  return true; // Block completed
}

// Block validation (unchanged)
export async function validateBlock(currentBlock: number): Promise<void> {
  const maxRetries = 5;
  let retryCount = 0;
  let blockValidated = false;

  while (retryCount <= maxRetries && !blockValidated) {
    try {
      const latestBlockNumber = await getLatestBlockNumber(syncingProvider_v9);
      if (latestBlockNumber + 1 === currentBlock) {
        blockValidated = true;
      } else {
        throw new Error(
          `Sync block ${currentBlock} is not 1 + ${latestBlockNumber}`,
        );
      }
    } catch (error) {
      retryCount++;
      console.warn(
        `Block validation attempt ${retryCount} failed for block ${currentBlock}:`,
        error,
      );

      if (retryCount > maxRetries) {
        throw new Error(
          `Failed to validate block ${currentBlock} after ${
            maxRetries + 1
          } attempts. Latest error: ${error}`,
        );
      }

      const delay = Math.pow(2, retryCount) * 1000;
      console.log(`Retrying block ${currentBlock} validation in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// // Graceful shutdown handler
// export const gracefulShutdown = async (signal: string): Promise<void> => {
//   console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

//   if (currentProcess && currentProcess.status === "running") {
//     logger.info(`Gracefully shutting down sync process ${currentProcess.id}`);
//     currentProcess.cancelRequested = true;

//     // Wait a bit for the current transaction to complete, but not too long
//     console.log("Waiting for current transaction to complete...");
//     await Promise.race([
//       new Promise((resolve) => setTimeout(resolve, 3000)), // Max 3 seconds wait
//       new Promise((resolve) => {
//         const checkInterval = setInterval(() => {
//           if (!currentProcess || currentProcess.status !== "running") {
//             clearInterval(checkInterval);
//             resolve(undefined);
//           }
//         }, 100);
//       }),
//     ]);
//   }

//   console.log("Shutting down...");
//   process.exit(0);
// };

// // Process cleanup on application exit
// let shutdownInProgress = false;

// process.on("SIGINT", async () => {
//   if (shutdownInProgress) {
//     console.log("\nForce exiting...");
//     process.exit(1);
//   }
//   shutdownInProgress = true;
//   await gracefulShutdown("SIGINT");
// });

// process.on("SIGTERM", async () => {
//   if (shutdownInProgress) {
//     process.exit(1);
//   }
//   shutdownInProgress = true;
//   await gracefulShutdown("SIGTERM");
// });

// // Get sync status endpoint
// export const getSyncStatus = async (req: Request, res: Response) => {
//   try {
//     const processId = req.params.processId || (req.query.processId as string);

//     if (processId) {
//       const process = processHistory.get(processId);
//       if (!process) {
//         return res.status(404).json({
//           error: "Process not found",
//         });
//       }

//       return res.json({
//         processId: process.id,
//         status: process.status,
//         progress: {
//           currentBlock: process.currentBlock,
//           currentTxIndex: process.currentTxIndex,
//           processedBlocks: process.processedBlocks,
//           totalBlocks: process.totalBlocks,
//           percentage: process.totalBlocks
//             ? Math.round((process.processedBlocks / process.totalBlocks) * 100)
//             : null, // No percentage for continuous sync
//           syncMode: process.isContinuousSync ? "continuous" : "fixed_range",
//         },
//         timing: {
//           startTime: process.startTime,
//           endTime: process.endTime,
//           duration: process.endTime
//             ? process.endTime.getTime() - process.startTime.getTime()
//             : Date.now() - process.startTime.getTime(),
//         },
//         error: process.error,
//       });
//     }

//     // Return current process if no specific ID requested
//     if (currentProcess) {
//       return res.json({
//         processId: currentProcess.id,
//         status: currentProcess.status,
//         syncMode: currentProcess.isContinuousSync
//           ? "continuous"
//           : "fixed_range",
//         progress: {
//           currentBlock: currentProcess.currentBlock,
//           currentTxIndex: currentProcess.currentTxIndex,
//           processedBlocks: currentProcess.processedBlocks,
//           totalBlocks: currentProcess.totalBlocks,
//           percentage: currentProcess.totalBlocks
//             ? Math.round(
//                 (currentProcess.processedBlocks / currentProcess.totalBlocks) *
//                   100,
//               )
//             : null,
//         },
//       });
//     }

//     res.json({
//       message: "No sync process currently running",
//     });
//   } catch (error) {
//     res.status(500).json({
//       error: `Failed to get status: ${error}`,
//     });
//   }
// };

// // Cancel sync endpoint
// export const cancelSync = async (req: Request, res: Response) => {
//   try {
//     const processId = req.params.processId || req.body.processId;
//     const completeCurrentBlock = req.body.complete_current_block || false;

//     if (processId && processId !== currentProcess?.id) {
//       return res.status(404).json({
//         error: "Process not found or not currently running",
//       });
//     }

//     if (!currentProcess || currentProcess.status !== "running") {
//       return res.status(400).json({
//         error: "No sync process currently running",
//       });
//     }

//     // Mark for cancellation
//     currentProcess.cancelRequested = true;
//     currentProcess.completeCurrentBlock = completeCurrentBlock;

//     res.json({
//       message: completeCurrentBlock
//         ? "Cancellation requested - will complete current block and stop"
//         : "Cancellation requested - will stop immediately after current transaction",
//       processId: currentProcess.id,
//       cancellationMode: completeCurrentBlock
//         ? "complete_current_block"
//         : "immediate",
//       currentBlock: currentProcess.currentBlock,
//       currentTxIndex: currentProcess.currentTxIndex,
//       note: completeCurrentBlock
//         ? "Process will complete all transactions in current block before stopping"
//         : "Process will stop after completing current transaction",
//       resumeInfo: {
//         message:
//           "To resume from this point, use these parameters in your next sync request:",
//         syncFrom: currentProcess.currentBlock,
//         startTxIndex: completeCurrentBlock ? 0 : currentProcess.currentTxIndex,
//       },
//     });
//   } catch (error) {
//     res.status(500).json({
//       error: `Failed to cancel sync: ${error}`,
//     });
//   }
// };

// // Get process history
// export const getProcessHistory = async (req: Request, res: Response) => {
//   try {
//     const limit = parseInt(req.query.limit as string) || 10;
//     const processes = Array.from(processHistory.values())
//       .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
//       .slice(0, limit);

//     res.json({
//       processes: processes.map((p) => ({
//         processId: p.id,
//         status: p.status,
//         syncFrom: p.syncFrom,
//         syncTo: p.syncTo,
//         currentBlock: p.currentBlock,
//         currentTxIndex: p.currentTxIndex,
//         progress: `${p.processedBlocks}/${p.totalBlocks} blocks`,
//         startTime: p.startTime,
//         endTime: p.endTime,
//         duration: p.endTime
//           ? p.endTime.getTime() - p.startTime.getTime()
//           : null,
//         error: p.error,
//       })),
//     });
//   } catch (error) {
//     res.status(500).json({
//       error: `Failed to get process history: ${error}`,
//     });
//   }
// };
