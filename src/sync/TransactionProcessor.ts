import logger from "../logger.js";
import { TransactionWithHash } from "starknet";
import { processTx } from "../transactions/index.js";
import { getPreConfirmedBlock } from "../operations/blockOperations.js";
import { validateBlockReceipts } from "../operations/transactionOperations.js";
import { syncingProvider } from "../providers.js";
import { MadaraDownError } from "../errors/index.js";
import { TransactionResult, SendTransactionsResult } from "../types.js";
import { config } from "../config.js";
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
   * Send transactions sequentially. Optional per-transaction preconfirmation
   * validation is retained for compatibility, but disabled for pipelined replay.
   */
  async sendTransactions(
    transactions: TransactionWithHash[],
    blockNumber: number,
    shouldAbort?: () => boolean
  ): Promise<SendTransactionsResult> {
    if (transactions.length === 0) {
      return { txResults: [], txHashes: [], sendDuration: 0 };
    }

    const sequentialValidation = config.sequentialValidation;
    const mode = sequentialValidation ? "send-and-validate" : "fire-and-forget";
    logger.info(
      `Sending ${transactions.length} transactions sequentially (${mode})...`
    );

    const startTime = Date.now();
    const endTimer = startTimer();
    const txResults: TransactionResult[] = [];
    const txHashes: string[] = [];

    // SEQUENTIAL SENDING
    for (let index = 0; index < transactions.length; index++) {
      if (shouldAbort?.()) {
        throw new Error(`Transaction sending aborted for block ${blockNumber}`);
      }

      const tx = transactions[index];

      try {
        const txHash = tx.transaction_hash;
        txHashes.push(txHash);

        logger.debug(
          `  [${index + 1}/${transactions.length}] Sending tx: ${txHash}`
        );

        await processTx(tx, blockNumber);

        if (sequentialValidation) {
          await this.waitForTxInPreConfirmed(
            txHash,
            blockNumber,
            index + 1,
            transactions.length,
            shouldAbort
          );
        }

        txResults.push({
          txHash,
          success: true,
        });
      } catch (error: any) {
        if (error instanceof MadaraDownError) {
          logger.warn(
            `Madara down while sending transaction ${index + 1}/${
              transactions.length
            }`
          );
          throw error; // Propagate to caller for recovery handling
        }

        logger.error(
          `  Failed to send transaction ${index + 1}:`,
          error.message
        );
        throw new Error(
          `Failed to send transaction ${index + 1}/${
            transactions.length
          } in block ${blockNumber}: ${error.message}`
        );
      }
    }

    const sendDuration = Date.now() - startTime;
    logger.info(
      `All ${transactions.length} transactions sent in ${sendDuration}ms`
    );

    // Record transaction sending duration
    recordBlockProcessingDuration("send_txs", endTimer());

    return {
      txResults,
      txHashes,
      sendDuration,
    };
  }

  /**
   * Poll the destination preconfirmed block until one transaction appears.
   * The abort callback lets the pipeline stop promptly after another worker fails.
   */
  private async waitForTxInPreConfirmed(
    txHash: string,
    blockNumber: number,
    txIndex: number,
    totalTxs: number,
    shouldAbort?: () => boolean,
    maxRetries: number = 500,
    retryDelayMs: number = 200
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (shouldAbort?.()) {
        throw new Error(
          `Transaction preconfirmation wait aborted for block ${blockNumber}`
        );
      }

      try {
        const preConfirmedBlock = await getPreConfirmedBlock(syncingProvider);
        const pendingTxHashes = (preConfirmedBlock.transactions ||
          []) as string[];

        if (pendingTxHashes.includes(txHash)) {
          logger.debug(
            `  [${txIndex}/${totalTxs}] Tx ${txHash} confirmed in PRE_CONFIRMED (attempt ${attempt})`
          );
          return;
        }

        if (attempt % 50 === 0) {
          logger.info(
            `  [${txIndex}/${totalTxs}] Still waiting for tx ${txHash} in PRE_CONFIRMED (attempt ${attempt}/${maxRetries})`
          );
        }
      } catch (error) {
        if (error instanceof MadaraDownError) {
          throw error;
        }
        logger.warn(
          `  [${txIndex}/${totalTxs}] Error polling PRE_CONFIRMED (attempt ${attempt}/${maxRetries}): ${error}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    throw new Error(
      `Transaction ${txHash} not found in PRE_CONFIRMED block ${blockNumber} after ${maxRetries} attempts`
    );
  }

  /**
   * Validate receipts for a block (call this AFTER closeBlock)
   */
  async validateReceipts(
    blockNumber: number,
    txHashes: string[],
    shouldAbort?: () => boolean
  ): Promise<void> {
    if (txHashes.length === 0) {
      return;
    }

    logger.info(
      `Validating ${txHashes.length} receipts using getBlockWithReceipts...`
    );

    const startTime = Date.now();

    try {
      await validateBlockReceipts(
        syncingProvider,
        blockNumber,
        txHashes,
        shouldAbort
      );
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
