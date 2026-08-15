import logger from "../logger.js";
import { TransactionWithHash } from "starknet";
import { processTx } from "../transactions/index.js";
import type { TransactionSubmissionMode } from "../transactions/index.js";
import {
  assertTransactionExecutionStatusMatches,
  validateBlockReceipts,
  waitForTransactionExecutionStatus,
} from "../operations/transactionOperations.js";
import { syncingProvider } from "../providers.js";
import {
  getPreConfirmedBlock,
  getReplayBoundaryStatus,
} from "../operations/blockOperations.js";
import { MadaraDownError } from "../errors/index.js";
import {
  TransactionResult,
  SendTransactionsResult,
  ExecutionStatus,
} from "../types.js";
import {
  recordBlockProcessingDuration,
  startTimer,
} from "../telemetry/metrics.js";
import { config } from "../config.js";
import { TransactionOnlyReplayConfig } from "../constants.js";

const BLOCKIFIER_BENCHMARK_WITHDRAWAL_TX =
  "0x3f55308078a6bc808447c77909ebb062416de42acb3ea31a466532a80976845";
const BLOCKIFIER_BENCHMARK_BALANCE_UPDATE_TX =
  "0x663482430fb4490128452304d1ec257ec23cb98d0aecf742ade1073c1c7630f";
const BLOCKIFIER_BENCHMARK_SECOND_BALANCE_PREREQUISITE_TX =
  "0x2a2aca6e81fc72999763ad388cfd4f3c257b5f3e336d865479590e438244b9b";
const BLOCKIFIER_BENCHMARK_SECOND_BALANCE_UPDATE_TX =
  "0x170cc18cdc09097f55b0b2d619ff298d97dce48188cc3c115ce1adecb4313d1";
const BLOCKIFIER_BENCHMARK_SECOND_WITHDRAWAL_TX =
  "0x462eb7ca68773442217fba696e34953000945cc2d432abdf1c2767d0ca9bd99";

const BLOCKIFIER_BENCHMARK_DEPENDENCIES: Readonly<Record<string, string>> = {
  [BLOCKIFIER_BENCHMARK_WITHDRAWAL_TX]:
    BLOCKIFIER_BENCHMARK_BALANCE_UPDATE_TX,
  [BLOCKIFIER_BENCHMARK_SECOND_BALANCE_UPDATE_TX]:
    BLOCKIFIER_BENCHMARK_SECOND_BALANCE_PREREQUISITE_TX,
  [BLOCKIFIER_BENCHMARK_SECOND_WITHDRAWAL_TX]:
    BLOCKIFIER_BENCHMARK_SECOND_BALANCE_UPDATE_TX,
};

export function getBenchmarkMempoolDependency(
  txHash: string,
  submissionMode: TransactionSubmissionMode,
): string | undefined {
  return submissionMode === "mempool"
    ? BLOCKIFIER_BENCHMARK_DEPENDENCIES[txHash.toLowerCase()]
    : undefined;
}

/**
 * Process transactions for a block
 * Sends transactions sequentially. Receipt validation happens after block is closed.
 */
export class ParallelTransactionProcessor {
  /**
   * Send transactions sequentially.
   * When SEQUENTIAL_VALIDATION is enabled, each transaction is confirmed
   * in the PRE_CONFIRMED block before the next one is sent.
   */
  async sendTransactions(
    transactions: TransactionWithHash[],
    blockNumber: number,
    requirePreConfirmedValidation: boolean = false,
    delayBetweenTxsMs: number = 0,
    shouldAbort?: () => boolean,
    submissionMode: TransactionSubmissionMode = "bypass",
  ): Promise<SendTransactionsResult> {
    if (transactions.length === 0) {
      return { txResults: [], txHashes: [], sendDuration: 0 };
    }

    const preConfirmedValidation =
      requirePreConfirmedValidation || config.sequentialValidation;
    const mode = preConfirmedValidation
      ? "send-and-preconfirmed-validate"
      : "fire-and-forget";
    logger.info(
      `📤 Sending ${transactions.length} transactions sequentially (${mode})...`,
    );

    const startTime = Date.now();
    const endTimer = startTimer();
    const txResults: TransactionResult[] = [];
    const txHashes: string[] = [];

    for (let index = 0; index < transactions.length; index++) {
      if (shouldAbort?.()) {
        throw new Error(`Transaction sending aborted for block ${blockNumber}`);
      }
      const tx = transactions[index];

      try {
        const txHash = tx.transaction_hash;
        txHashes.push(txHash);

        const dependencyTxHash = getBenchmarkMempoolDependency(
          txHash,
          submissionMode,
        );
        if (dependencyTxHash) {
          logger.info(
            `⏸️ Holding benchmark tx ${txHash} until dependency ${dependencyTxHash} succeeds`,
          );
          const dependencyStatus = await waitForTransactionExecutionStatus(
            syncingProvider,
            dependencyTxHash,
          );
          if (dependencyStatus !== "SUCCEEDED") {
            throw new Error(
              `Benchmark dependency ${dependencyTxHash} reached ${dependencyStatus}`,
            );
          }
          logger.info(
            `✅ Benchmark dependency ${dependencyTxHash} succeeded; submitting ${txHash}`,
          );
        }

        logger.debug(
          `  [${index + 1}/${transactions.length}] Sending tx: ${txHash}`,
        );

        await processTx(tx, blockNumber, submissionMode);

        if (preConfirmedValidation) {
          await this.waitForTxInPreConfirmed(
            txHash,
            blockNumber,
            index + 1,
            transactions.length,
          );
        }

        txResults.push({
          txHash,
          success: true,
        });

        if (delayBetweenTxsMs > 0 && index < transactions.length - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, delayBetweenTxsMs),
          );
        }
      } catch (error: any) {
        if (error instanceof MadaraDownError) {
          logger.warn(
            `Madara down while sending transaction ${index + 1}/${
              transactions.length
            }`,
          );
          throw error;
        }

        logger.error(
          `  Failed to send transaction ${index + 1}:`,
          error.message,
        );
        throw new Error(
          `Failed to send transaction ${index + 1}/${
            transactions.length
          } in block ${blockNumber}: ${error.message}`,
        );
      }
    }

    const sendDuration = Date.now() - startTime;
    logger.info(
      `✅ All ${transactions.length} transactions sent in ${sendDuration}ms`,
    );

    recordBlockProcessingDuration("send_txs", endTimer());

    return {
      txResults,
      txHashes,
      sendDuration,
    };
  }

  /**
   * Send transaction-only replay transactions one at a time and wait for Madara
   * to execute each one before submitting the next. This matches Madara's
   * replay-boundary close path and avoids overfilling the pending queue.
   */
  async sendTransactionsWithReplayBoundary(
    transactions: TransactionWithHash[],
    blockNumber: number,
    expectedExecutedCounts: number[],
  ): Promise<SendTransactionsResult> {
    if (transactions.length === 0) {
      return { txResults: [], txHashes: [], sendDuration: 0 };
    }

    if (transactions.length !== expectedExecutedCounts.length) {
      throw new Error(
        `Replay boundary send plan mismatch for block ${blockNumber}: transactions=${transactions.length}, expectedCounts=${expectedExecutedCounts.length}`,
      );
    }

    logger.info(
      `📤 Sending ${transactions.length} transaction-only replay transactions with boundary pacing...`,
    );

    const startTime = Date.now();
    const endTimer = startTimer();
    const txResults: TransactionResult[] = [];
    const txHashes: string[] = [];

    for (let index = 0; index < transactions.length; index++) {
      const tx = transactions[index];
      const txHash = tx.transaction_hash;
      const expectedExecutedCount = expectedExecutedCounts[index];

      try {
        txHashes.push(txHash);

        logger.info(
          `  [${index + 1}/${
            transactions.length
          }] Sending tx ${txHash}; waiting for replay executed=${expectedExecutedCount}`,
        );

        await processTx(tx, blockNumber);
        await this.waitForReplayBoundaryExecution(
          blockNumber,
          txHash,
          expectedExecutedCount,
          index + 1,
          transactions.length,
        );

        txResults.push({
          txHash,
          success: true,
        });
      } catch (error: any) {
        if (error instanceof MadaraDownError) {
          logger.warn(
            `Madara down while sending transaction-only replay tx ${
              index + 1
            }/${transactions.length}`,
          );
          throw error;
        }

        logger.error(
          `  Failed to send transaction-only replay tx ${index + 1}:`,
          error.message,
        );
        throw new Error(
          `Failed to send transaction-only replay tx ${index + 1}/${
            transactions.length
          } in block ${blockNumber}: ${error.message}`,
        );
      }
    }

    const sendDuration = Date.now() - startTime;
    logger.info(
      `✅ All ${transactions.length} transaction-only replay transactions sent and executed in ${sendDuration}ms`,
    );

    recordBlockProcessingDuration("send_txs", endTimer());

    return {
      txResults,
      txHashes,
      sendDuration,
    };
  }

  /**
   * Poll PRE_CONFIRMED block until the given transaction hash appears.
   */
  private async waitForTxInPreConfirmed(
    txHash: string,
    blockNumber: number,
    txIndex: number,
    totalTxs: number,
    maxRetries: number = 500,
    retryDelayMs: number = 200,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const preConfirmedBlock = await getPreConfirmedBlock(syncingProvider);
        const pendingTxHashes = (preConfirmedBlock.transactions ||
          []) as string[];

        if (pendingTxHashes.includes(txHash)) {
          logger.debug(
            `  [${txIndex}/${totalTxs}] Tx ${txHash} confirmed in PRE_CONFIRMED (attempt ${attempt})`,
          );
          return;
        }

        if (attempt % 50 === 0) {
          logger.info(
            `  [${txIndex}/${totalTxs}] Still waiting for tx ${txHash} in PRE_CONFIRMED (attempt ${attempt}/${maxRetries})`,
          );
        }
      } catch (error) {
        if (error instanceof MadaraDownError) {
          throw error;
        }
        logger.warn(
          `  [${txIndex}/${totalTxs}] Error polling PRE_CONFIRMED (attempt ${attempt}/${maxRetries}): ${error}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    throw new Error(
      `Transaction ${txHash} not found in PRE_CONFIRMED block ${blockNumber} after ${maxRetries} attempts`,
    );
  }

  private async waitForReplayBoundaryExecution(
    blockNumber: number,
    txHash: string,
    expectedExecutedCount: number,
    txIndex: number,
    totalTxs: number,
    maxRetries: number = TransactionOnlyReplayConfig.REPLAY_BOUNDARY_TX_MAX_RETRIES,
    retryDelayMs: number = TransactionOnlyReplayConfig.REPLAY_BOUNDARY_TX_RETRY_DELAY_MS,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const status = await getReplayBoundaryStatus(blockNumber);

        if (!status) {
          throw new Error(
            `Replay boundary status not found for block ${blockNumber}`,
          );
        }

        if (status.mismatch) {
          throw new Error(
            `Replay boundary mismatch for block ${blockNumber}: ${status.mismatch}`,
          );
        }

        if (status.closed && status.executed_tx_count < expectedExecutedCount) {
          throw new Error(
            `Replay boundary closed early for block ${blockNumber}: executed=${status.executed_tx_count}, expected_at_least=${expectedExecutedCount}`,
          );
        }

        if (status.executed_tx_count >= expectedExecutedCount) {
          if (
            status.executed_tx_count === expectedExecutedCount &&
            status.last_executed_tx_hash?.toLowerCase() !== txHash.toLowerCase()
          ) {
            throw new Error(
              `Replay boundary order mismatch for block ${blockNumber}: expected tx ${txHash} at executed=${expectedExecutedCount}, last_executed=${status.last_executed_tx_hash}`,
            );
          }

          logger.info(
            `  [${txIndex}/${totalTxs}] Replay boundary executed tx ${txHash}: executed=${status.executed_tx_count}`,
          );
          return;
        }

        if (attempt === 1 || attempt % 10 === 0) {
          logger.info(
            `  [${txIndex}/${totalTxs}] Waiting for replay boundary execution of ${txHash} (attempt ${attempt}/${maxRetries}): executed=${status.executed_tx_count}/${status.expected_tx_count}, dispatched=${status.dispatched_tx_count}`,
          );
        }
      } catch (error) {
        if (error instanceof MadaraDownError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("Replay boundary mismatch") ||
          message.includes("Replay boundary order mismatch") ||
          message.includes("Replay boundary closed early")
        ) {
          throw error;
        }

        logger.warn(
          `  [${txIndex}/${totalTxs}] Error checking replay boundary execution (attempt ${attempt}/${maxRetries}): ${error}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    throw new Error(
      `Replay boundary did not execute tx ${txHash} in block ${blockNumber} after ${maxRetries} attempts`,
    );
  }

  /**
   * Validate receipts for a block (call this AFTER closeBlock)
   */
  async validateReceipts(
    blockNumber: number,
    txHashes: string[],
    expectedStatuses?: Map<string, ExecutionStatus>,
  ): Promise<void> {
    if (txHashes.length === 0) {
      return;
    }

    logger.info(
      `🧾 Validating ${txHashes.length} receipts using getBlockWithReceipts...`,
    );

    const startTime = Date.now();

    try {
      await validateBlockReceipts(
        syncingProvider,
        blockNumber,
        txHashes,
        expectedStatuses,
      );
    } catch (error: any) {
      if (error instanceof MadaraDownError) {
        logger.warn(`Madara down detected during receipt validation`);
        throw error;
      }
      throw error;
    }

    const duration = Date.now() - startTime;
    logger.info(`✅ All receipts validated in ${duration}ms`);
  }

  async validateMempoolTransactionStatuses(
    sourceBlockNumber: number,
    txHashes: string[],
    expectedStatuses: Map<string, ExecutionStatus>,
  ): Promise<void> {
    if (txHashes.length === 0) {
      return;
    }

    logger.info(
      `🧾 Waiting for ${txHashes.length} mempool transaction(s) from source block ${sourceBlockNumber} to reach final execution status`,
    );
    const startTime = Date.now();

    await Promise.all(
      txHashes.map(async (txHash, txIndex) => {
        const actualStatus = await waitForTransactionExecutionStatus(
          syncingProvider,
          txHash,
        );
        const expectedStatus = expectedStatuses.get(txHash);
        if (expectedStatus) {
          assertTransactionExecutionStatusMatches(
            sourceBlockNumber,
            txHash,
            txIndex,
            expectedStatus,
            actualStatus,
          );
        }
      }),
    );

    logger.info(
      `✅ All ${
        txHashes.length
      } mempool transaction(s) from source block ${sourceBlockNumber} finalized with matching statuses in ${
        Date.now() - startTime
      }ms`,
    );
  }
}

// Export instance
export const parallelTransactionProcessor = new ParallelTransactionProcessor();
