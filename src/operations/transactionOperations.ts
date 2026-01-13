import { GetTransactionReceiptResponse, RpcProvider } from "starknet";
import logger from "../logger.js";
import {
  wrapMadaraError,
  MadaraDownError,
  isMadaraDownError,
} from "../errors/index.js";
import { RetryConfig, ReceiptValidationConfig } from "../constants.js";
import { RetryOptions, BlockWithReceipts } from "../types.js";
import axios, { AxiosResponse } from "axios";
import { transactionPostRetry } from "../retry/index.js";
import { incrementTransactionReceiptRetries } from "../telemetry/metrics.js";
import { getNodeName } from "../providers.js";
import { getBlockWithReceipts } from "./blockOperations.js";

/**
 * Get transaction receipt
 */
export async function getTransactionReceipt(
  provider: RpcProvider,
  transactionHash: string,
): Promise<GetTransactionReceiptResponse> {
  const nodeName = getNodeName(provider);

  try {
    const receipt = await provider.getTransactionReceipt(transactionHash);
    return receipt;
  } catch (error) {
    throw wrapMadaraError(error, `getTransactionReceipt(${transactionHash}) [${nodeName}]`);
  }
}

/**
 * Validate transaction receipt with configurable retry logic
 */
export async function validateTransactionReceipt(
  provider: RpcProvider,
  txHash: string,
  options: RetryOptions = {},
): Promise<void> {
  const nodeName = getNodeName(provider);
  const {
    maxRetries = RetryConfig.MAX_RETRIES_RECEIPT_VALIDATION,
    useExponentialBackoff = false,
    fixedDelay = RetryConfig.RECEIPT_VALIDATION_SUBSEQUENT_DELAY,
  } = options;

  let retryCount = 0;
  let consecutiveConnectionErrors = 0;

  while (retryCount <= maxRetries) {
    try {
      logger.debug(
        `Validating receipt for ${txHash} [${nodeName}] (attempt ${retryCount + 1}/${maxRetries + 1})`,
      );

      const receipt = await getTransactionReceipt(provider, txHash);

      // Validate transaction status
      if (!receipt.isSuccess() && !receipt.isReverted()) {
        throw new Error(`Transaction in unexpected state: ${txHash} [${nodeName}]`);
      }

      // Success
      return;
    } catch (error) {
      // Check if this is a Madara down error - fail fast
      if (error instanceof MadaraDownError) {
        logger.warn(
          `Madara connection error while validating receipt for ${txHash} [${nodeName}]`,
        );
        throw error;
      }

      // Check for connection errors
      if (isMadaraDownError(error)) {
        consecutiveConnectionErrors++;
        logger.warn(
          `Connection error ${consecutiveConnectionErrors}/${RetryConfig.MAX_CONSECUTIVE_CONNECTION_ERRORS} for ${txHash} [${nodeName}]`,
        );

        if (
          consecutiveConnectionErrors >=
          RetryConfig.MAX_CONSECUTIVE_CONNECTION_ERRORS
        ) {
          logger.error(
            `Too many consecutive connection errors (${consecutiveConnectionErrors}) [${nodeName}]`,
          );
          throw new MadaraDownError(
            `Madara down while validating receipt for ${txHash} [${nodeName}] after ${consecutiveConnectionErrors} connection errors`,
          );
        }
      } else {
        // Reset on non-connection errors
        consecutiveConnectionErrors = 0;
      }

      retryCount++;

      // Record retry metric
      incrementTransactionReceiptRetries("unknown");

      if (retryCount > maxRetries) {
        const errorMsg = `Failed to validate receipt for ${txHash} [${nodeName}] after ${maxRetries} attempts`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      // Calculate delay
      const delay = useExponentialBackoff
        ? Math.pow(2, retryCount) * 1000
        : fixedDelay;

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Post data to RPC endpoint with retry logic and Madara health detection
 *
 * This function handles transient errors with retries, but throws MadaraDownError
 * when Madara is detected as down. The caller is responsible for handling Madara
 * recovery and checking PRE_CONFIRMED block state.
 */
export async function postWithRetry(
  url: string,
  data: Record<string, any>,
): Promise<AxiosResponse<any>> {
  const { checkMadaraHealth } = await import("../madara/index.js");

  let attempt = 0;
  const maxAttempts = RetryConfig.MAX_RETRIES_TRANSACTION_POST;

  while (attempt <= maxAttempts) {
    try {
      const result = await axios.post(url, data);

      // Check for account validation error (code 55) - needs retry
      if (result.data.error && result.data.error.code === 55) {
        if (attempt >= maxAttempts) {
          throw new Error(
            `Account validation failed after ${maxAttempts + 1} attempts: ${result.data.error.message}`,
          );
        }

        logger.warn(
          `⚠️  Account validation failed (attempt ${attempt + 1}/${maxAttempts + 1}), retrying: ${JSON.stringify(result.data)}`,
        );
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 second delay for account validation
        continue;
      }

      // Success
      if (attempt > 0) {
        logger.info(`✅ POST ${url} succeeded on attempt ${attempt + 1}`);
      }
      return result;
    } catch (error) {
      const wrappedError = wrapMadaraError(error, `postWithRetry(${url})`);

      // Check if this is a connection error (potential Madara down)
      if (
        wrappedError instanceof MadaraDownError ||
        isMadaraDownError(wrappedError)
      ) {
        logger.warn(
          `⚠️  POST ${url} failed (attempt ${attempt + 1}/${maxAttempts + 1}): ${wrappedError.message}`,
        );

        // Check Madara health immediately to distinguish between:
        // - Madara being down (throw MadaraDownError for block-level recovery)
        // - Transient connection error (retry with short delay)
        logger.info(`🔍 Checking Madara health status...`);
        const isHealthy = await checkMadaraHealth();

        if (!isHealthy) {
          logger.warn(
            `🚨 Madara is DOWN - propagating MadaraDownError for block-level recovery`,
          );
          // Throw MadaraDownError to trigger block-level recovery
          // which will check PRE_CONFIRMED state and restart the block if needed
          throw new MadaraDownError(
            `Madara down detected while posting transaction`,
          );
        } else {
          logger.info(
            `✅ Madara is healthy - treating as transient connection error`,
          );

          if (attempt >= maxAttempts) {
            throw new Error(
              `POST ${url} failed after ${maxAttempts + 1} attempts: ${wrappedError.message}`,
            );
          }

          // Transient error, retry with short delay
          attempt++;
          const delay = 1000; // 1 second for transient errors
          logger.info(`⏸️  Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // Non-connection error - throw immediately
      throw wrappedError;
    }
  }

  throw new Error(`POST ${url} failed after ${maxAttempts + 1} attempts`);
}

/**
 * Get the polling interval based on elapsed time (phased polling)
 * Phase 1 (0-5s): 100ms
 * Phase 2 (5s-1min): 500ms
 * Phase 3 (>1min): 2000ms
 */
function getPollingInterval(elapsedMs: number): number {
  if (elapsedMs < ReceiptValidationConfig.PHASE1_DURATION_MS) {
    return ReceiptValidationConfig.PHASE1_INTERVAL_MS;
  }
  if (elapsedMs < ReceiptValidationConfig.PHASE2_DURATION_MS) {
    return ReceiptValidationConfig.PHASE2_INTERVAL_MS;
  }
  return ReceiptValidationConfig.PHASE3_INTERVAL_MS;
}

/**
 * Validate all transaction receipts for a block using getBlockWithReceipts
 * Uses phased polling: fast initially, then slower over time
 * Times out after 15 minutes
 */
export async function validateBlockReceipts(
  provider: RpcProvider,
  blockNumber: number,
  expectedTxHashes: string[],
): Promise<void> {
  const nodeName = getNodeName(provider);
  const startTime = Date.now();
  const timeout = ReceiptValidationConfig.TIMEOUT_MS;

  logger.info(
    `Validating ${expectedTxHashes.length} receipts for block ${blockNumber} [${nodeName}]`,
  );

  // Initial delay before starting validation
  await new Promise((resolve) =>
    setTimeout(resolve, ReceiptValidationConfig.INITIAL_DELAY_MS),
  );

  let pollCount = 0;
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5;

  while (true) {
    const elapsed = Date.now() - startTime;

    // Check timeout
    if (elapsed >= timeout) {
      const errorMsg = `Receipt validation timed out after ${Math.round(elapsed / 1000)}s for block ${blockNumber} [${nodeName}]`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    pollCount++;
    const interval = getPollingInterval(elapsed);

    try {
      const blockWithReceipts = await getBlockWithReceipts(provider, blockNumber);

      if (!blockWithReceipts) {
        // Block not ready yet, wait and retry
        logger.debug(
          `Block ${blockNumber} not ready yet, retrying in ${interval}ms (poll #${pollCount}, ${Math.round(elapsed / 1000)}s elapsed)`,
        );
        consecutiveErrors = 0; // Reset on successful RPC (just no block yet)
        await new Promise((resolve) => setTimeout(resolve, interval));
        continue;
      }

      // Block found - validate receipts
      const receipts = blockWithReceipts.transactions;
      const receiptMap = new Map(
        receipts.map((txWithReceipt) => [
          txWithReceipt.receipt.transaction_hash,
          txWithReceipt.receipt,
        ]),
      );

      // Check all expected transactions have receipts
      const missingTxs: string[] = [];
      const failedTxs: string[] = [];

      for (const txHash of expectedTxHashes) {
        const receipt = receiptMap.get(txHash);

        if (!receipt) {
          missingTxs.push(txHash);
          continue;
        }

        // Check execution status
        if (
          receipt.execution_status !== "SUCCEEDED" &&
          receipt.execution_status !== "REVERTED"
        ) {
          failedTxs.push(
            `${txHash} (status: ${receipt.execution_status})`,
          );
        }
      }

      if (missingTxs.length > 0) {
        // Some transactions not in block yet - this shouldn't happen if block is finalized
        logger.warn(
          `Block ${blockNumber} missing ${missingTxs.length} expected transactions, retrying...`,
        );
        await new Promise((resolve) => setTimeout(resolve, interval));
        continue;
      }

      if (failedTxs.length > 0) {
        const errorMsg = `${failedTxs.length} transactions in unexpected state for block ${blockNumber}: ${failedTxs.join(", ")}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      // All receipts validated successfully
      const duration = Date.now() - startTime;
      logger.info(
        `All ${expectedTxHashes.length} receipts validated for block ${blockNumber} in ${duration}ms (${pollCount} polls) [${nodeName}]`,
      );
      return;
    } catch (error) {
      // Check for Madara down
      if (error instanceof MadaraDownError || isMadaraDownError(error)) {
        logger.warn(
          `Madara connection error during receipt validation for block ${blockNumber} [${nodeName}]`,
        );
        throw new MadaraDownError(
          `Madara down while validating receipts for block ${blockNumber}`,
        );
      }

      consecutiveErrors++;

      if (consecutiveErrors >= maxConsecutiveErrors) {
        logger.error(
          `Too many consecutive errors (${consecutiveErrors}) validating receipts for block ${blockNumber}`,
        );
        throw error;
      }

      // Transient error, retry
      logger.warn(
        `Error validating receipts (attempt ${pollCount}), retrying: ${error}`,
      );
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
