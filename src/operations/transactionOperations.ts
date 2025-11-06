import { GetTransactionReceiptResponse, RpcProvider } from "starknet";
import logger from "../logger.js";
import {
  wrapMadaraError,
  MadaraDownError,
  isMadaraDownError,
} from "../errors/index.js";
import { RetryConfig } from "../constants.js";
import { RetryOptions } from "../types.js";
import axios, { AxiosResponse } from "axios";
import { transactionPostRetry } from "../retry/index.js";

// Nonce tracker for special address
const nonceTracker: Record<string, number> = {};

/**
 * Get nonce for an address with special handling for "0x1"
 */
export async function getNonce(
  address: string,
  provider: RpcProvider,
  nonce: string,
): Promise<string> {
  if (address !== "0x1") {
    return nonce;
  }

  try {
    if (nonceTracker[address] === undefined) {
      nonceTracker[address] = Number(
        await provider.getNonceForAddress(address),
      );
    }

    const addressNonce = nonceTracker[address];
    nonceTracker[address] += 1;

    return `0x${addressNonce.toString(16)}`;
  } catch (error) {
    throw wrapMadaraError(error, `getNonce(${address})`);
  }
}

/**
 * Get transaction receipt
 */
export async function getTransactionReceipt(
  provider: RpcProvider,
  transactionHash: string,
): Promise<GetTransactionReceiptResponse> {
  try {
    const receipt = await provider.getTransactionReceipt(transactionHash);
    return receipt;
  } catch (error) {
    throw wrapMadaraError(error, `getTransactionReceipt(${transactionHash})`);
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
        `Validating receipt for ${txHash} (attempt ${retryCount + 1}/${maxRetries + 1})`,
      );

      const receipt = await getTransactionReceipt(provider, txHash);

      // Validate transaction status
      if (!receipt.isSuccess() && !receipt.isReverted()) {
        throw new Error(`Transaction in unexpected state: ${txHash}`);
      }

      // Success
      return;
    } catch (error) {
      // Check if this is a Madara down error - fail fast
      if (error instanceof MadaraDownError) {
        logger.warn(
          `🚨 Madara connection error while validating receipt for ${txHash}`,
        );
        throw error;
      }

      // Check for connection errors
      if (isMadaraDownError(error)) {
        consecutiveConnectionErrors++;
        logger.warn(
          `⚠️  Connection error ${consecutiveConnectionErrors}/${RetryConfig.MAX_CONSECUTIVE_CONNECTION_ERRORS} for ${txHash}`,
        );

        if (
          consecutiveConnectionErrors >=
          RetryConfig.MAX_CONSECUTIVE_CONNECTION_ERRORS
        ) {
          logger.error(
            `❌ Too many consecutive connection errors (${consecutiveConnectionErrors})`,
          );
          throw new MadaraDownError(
            `Madara down while validating receipt for ${txHash} after ${consecutiveConnectionErrors} connection errors`,
          );
        }
      } else {
        // Reset on non-connection errors
        consecutiveConnectionErrors = 0;
      }

      retryCount++;

      if (retryCount > maxRetries) {
        const errorMsg = `Failed to validate receipt for ${txHash} after ${maxRetries} attempts`;
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
