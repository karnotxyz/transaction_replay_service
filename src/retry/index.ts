export * from "./strategies.js";
export * from "./executor.js";

import {
  ExponentialBackoffStrategy,
  FixedDelayStrategy,
  LinearBackoffStrategy,
  NoRetryStrategy,
} from "./strategies.js";
import { RetryExecutor } from "./executor.js";
import { RetryConfig, BlockProcessing } from "../constants.js";

/**
 * Pre-configured retry executors for common operations
 */

// Block fetching with exponential backoff
export const blockFetchRetry = new RetryExecutor(
  new ExponentialBackoffStrategy(
    RetryConfig.MAX_RETRIES_BLOCK_FETCH,
    RetryConfig.BASE_DELAY_EXPONENTIAL,
  ),
);

// Block validation
export const blockValidationRetry = new RetryExecutor(
  new ExponentialBackoffStrategy(
    RetryConfig.MAX_RETRIES_BLOCK_VALIDATION,
    RetryConfig.BASE_DELAY_EXPONENTIAL,
  ),
);

// Receipt validation with fixed delay
export const receiptValidationRetry = new RetryExecutor(
  new FixedDelayStrategy(
    RetryConfig.MAX_RETRIES_RECEIPT_VALIDATION,
    RetryConfig.RECEIPT_VALIDATION_SUBSEQUENT_DELAY,
  ),
);

// Receipt validation for parallel processing (higher retry count)
export const parallelReceiptValidationRetry = new RetryExecutor(
  new FixedDelayStrategy(
    RetryConfig.MAX_RETRIES_RECEIPT_VALIDATION_PARALLEL,
    RetryConfig.RECEIPT_VALIDATION_SUBSEQUENT_DELAY,
  ),
);

// Block hash matching
export const blockHashRetry = new RetryExecutor(
  new ExponentialBackoffStrategy(
    RetryConfig.MAX_RETRIES_BLOCK_HASH,
    BlockProcessing.BLOCK_HASH_RETRY_BASE_DELAY,
    30000, // Max 30 seconds
  ),
);

// Transaction posting with fixed long delay
export const transactionPostRetry = new RetryExecutor(
  new FixedDelayStrategy(
    RetryConfig.MAX_RETRIES_TRANSACTION_POST,
    RetryConfig.BASE_DELAY_TRANSACTION_POST,
  ),
);
