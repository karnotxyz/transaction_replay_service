import logger from "../logger.js";
import { TransactionWithHash } from "starknet";
import { processTx } from "../transactions/index.js";
import { validateBlockReceipts } from "../operations/transactionOperations.js";
import { syncingProvider_v9 } from "../providers.js";
import { MadaraDownError } from "../errors/index.js";
import { TransactionResult, SendTransactionsResult } from "../types.js";
import {
  recordBlockProcessingDuration,
  startTimer,
} from "../telemetry/metrics.js";

/**
 * Process transactions for a block
 * Sends transactions sequentially. Receipt validation happens after block is closed.
 */
export class ParallelTransactionProcessor {
  /**
   * Send transactions sequentially (no receipt validation - that happens after closeBlock)
   */
  async sendTransactions(
    transactions: TransactionWithHash[],
    blockNumber: number,
  ): Promise<SendTransactionsResult> {
    if (transactions.length === 0) {
      return { txResults: [], txHashes: [], sendDuration: 0 };
    }

    logger.info(
      `Sending ${transactions.length} transactions sequentially...`,
    );

    const startTime = Date.now();
    const endTimer = startTimer();
    const txResults: TransactionResult[] = [];
    const txHashes: string[] = [];

    // SEQUENTIAL SENDING
    for (let index = 0; index < transactions.length; index++) {
      const tx = transactions[index];

      try {
        const txHash = tx.transaction_hash;
        txHashes.push(txHash);

        logger.debug(
          `  [${index + 1}/${transactions.length}] Sending tx: ${txHash}`,
        );

        await processTx(tx, blockNumber);

        txResults.push({
          txHash,
          success: true,
        });
      } catch (error: any) {
        if (error instanceof MadaraDownError) {
          logger.warn(
            `Madara down while sending transaction ${index + 1}/${transactions.length}`,
          );
          throw error; // Propagate to caller for recovery handling
        }

        logger.error(
          `  Failed to send transaction ${index + 1}:`,
          error.message,
        );
        throw new Error(
          `Failed to send transaction ${index + 1}/${transactions.length} in block ${blockNumber}: ${error.message}`,
        );
      }
    }

    const sendDuration = Date.now() - startTime;
    logger.info(`All ${transactions.length} transactions sent in ${sendDuration}ms`);

    // Record transaction sending duration
    recordBlockProcessingDuration("send_txs", endTimer());

    return {
      txResults,
      txHashes,
      sendDuration,
    };
  }

  /**
   * Validate receipts for a block (call this AFTER closeBlock)
   */
  async validateReceipts(
    blockNumber: number,
    txHashes: string[],
  ): Promise<void> {
    if (txHashes.length === 0) {
      return;
    }

    logger.info(
      `Validating ${txHashes.length} receipts using getBlockWithReceipts...`,
    );

    const startTime = Date.now();

    try {
      await validateBlockReceipts(syncingProvider_v9, blockNumber, txHashes);
    } catch (error: any) {
      if (error instanceof MadaraDownError) {
        logger.warn(`Madara down detected during receipt validation`);
        throw error;
      }
      throw error;
    }

    const duration = Date.now() - startTime;
    logger.info(`All receipts validated in ${duration}ms`);
  }
}

// Export instance
export const parallelTransactionProcessor = new ParallelTransactionProcessor();
