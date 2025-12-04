import logger from "../logger.js";
import { TransactionWithHash } from "starknet";
import { processTx } from "../transactions/index.js";
import { validateTransactionReceipt } from "../operations/transactionOperations.js";
import { syncingProvider_v9 } from "../providers.js";
import { MadaraDownError } from "../errors/index.js";
import { BlockProcessing } from "../constants.js";
import { TransactionResult } from "../types.js";
import {
  recordBlockProcessingDuration,
  startTimer,
} from "../telemetry/metrics.js";

/**
 * Process transactions sequentially
 */
export class SequentialTransactionProcessor {
  /**
   * Process a single transaction
   */
  async processTransaction(
    tx: TransactionWithHash,
    blockNumber: number,
    index: number,
    totalTxs: number,
  ): Promise<string> {
    logger.info(
      `Processing transaction ${index + 1}/${totalTxs} - ${tx.transaction_hash}`,
    );

    const txHash = await processTx(tx, blockNumber);

    // Small delay between transactions
    await new Promise((resolve) =>
      setTimeout(resolve, BlockProcessing.TX_DELAY_BETWEEN_TXS),
    );

    // Special delay for first receipt
    if (index === 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, BlockProcessing.TX_DELAY_FIRST_RECEIPT),
      );
      await validateTransactionReceipt(syncingProvider_v9, txHash, {
        useExponentialBackoff: true,
      });
    } else {
      await validateTransactionReceipt(syncingProvider_v9, txHash, {
        maxRetries: 2000,
      });
    }

    return txHash;
  }
}

/**
 * Process transactions in parallel (sync mode)
 */
export class ParallelTransactionProcessor {
  /**
   * Send transactions sequentially, then validate receipts in parallel
   */
  async processTransactions(
    transactions: TransactionWithHash[],
    blockNumber: number,
  ): Promise<TransactionResult[]> {
    if (transactions.length === 0) {
      return [];
    }

    logger.info(
      `📤 Sending ${transactions.length} transactions SEQUENTIALLY...`,
    );

    const startTime = Date.now();
    const endTimer = startTimer();
    const txResults: TransactionResult[] = [];

    // SEQUENTIAL SENDING
    for (let index = 0; index < transactions.length; index++) {
      const tx = transactions[index];

      // Add 1 second delay between transactions
      // if (index > 0) {
      //   await new Promise((resolve) => setTimeout(resolve, 2000));
      // }

      try {
        const txHash = tx.transaction_hash;

        logger.info(
          `  📤 [${index + 1}/${transactions.length}] Sending tx: ${txHash}`,
        );

        await processTx(tx, blockNumber);

        txResults.push({
          txHash,
          success: true,
        });
      } catch (error: any) {
        if (error instanceof MadaraDownError) {
          logger.warn(
            `🚨 Madara down while sending transaction ${index + 1}/${transactions.length}`,
          );
          throw error; // Propagate to caller for recovery handling
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

    // PARALLEL RECEIPT VALIDATION
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
          throw error; // Propagate for recovery
        }
        logger.error(
          `  ❌ Receipt validation failed for ${result.txHash}:`,
          error.message,
        );
        // Throw the error instead of returning failure object
        // This ensures Promise.allSettled marks it as rejected
        throw error;
      }
    });

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
      logger.warn(`🚨 Madara down detected during parallel receipt validation`);
      throw (madaraDownError as PromiseRejectedResult).reason;
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

    // Record total transaction processing duration for this block
    recordBlockProcessingDuration("process_txs", endTimer());

    return txResults;
  }
}

// Export instances
export const sequentialTransactionProcessor =
  new SequentialTransactionProcessor();
export const parallelTransactionProcessor = new ParallelTransactionProcessor();
