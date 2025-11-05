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
import { incrementTransactionReceiptRetries } from "../telemetry/metrics.js";

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

      // Record retry metric
      incrementTransactionReceiptRetries("unknown");

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
 * Post data to RPC endpoint with retry logic
 */
export async function postWithRetry(
  url: string,
  data: Record<string, any>,
): Promise<AxiosResponse<any>> {
  return transactionPostRetry.execute(async () => {
    try {
      const result = await axios.post(url, data);

      // Check for account validation error (code 55)
      if (result.data.error && result.data.error.code === 55) {
        logger.warn(
          `Account validation failed, will retry: ${JSON.stringify(result.data)}`,
        );
        throw new Error(
          `Account validation failed: ${result.data.error.message}`,
        );
      }

      return result;
    } catch (error) {
      throw wrapMadaraError(error, `postWithRetry(${url})`);
    }
  }, `POST ${url}`);
}
