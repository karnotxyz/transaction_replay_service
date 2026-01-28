export * from "./strategies.js";
export * from "./executor.js";

import {
  ExponentialBackoffStrategy,
  FixedDelayStrategy,
  LinearBackoffStrategy,
  NoRetryStrategy,
} from "./strategies.js";
import { RetryExecutor, failFastOnMadaraDown } from "./executor.js";
import { RetryConfig, BlockProcessing } from "../constants.js";

/**
 * Pre-configured retry executors for common operations
 */

// Block fetching with exponential backoff
// Uses failFastOnMadaraDown to preserve MadaraDownError type for recovery handling
export const blockFetchRetry = new RetryExecutor(
  new ExponentialBackoffStrategy(
    RetryConfig.MAX_RETRIES_BLOCK_FETCH,
    RetryConfig.BASE_DELAY_EXPONENTIAL,
  ),
  failFastOnMadaraDown,
);

// Block validation
// Uses failFastOnMadaraDown to preserve MadaraDownError type for recovery handling
export const blockValidationRetry = new RetryExecutor(
  new ExponentialBackoffStrategy(
    RetryConfig.MAX_RETRIES_BLOCK_VALIDATION,
    RetryConfig.BASE_DELAY_EXPONENTIAL,
  ),
  failFastOnMadaraDown,
);

// Receipt validation with fixed delay
// Uses failFastOnMadaraDown to preserve MadaraDownError type for recovery handling
export const receiptValidationRetry = new RetryExecutor(
  new FixedDelayStrategy(
    RetryConfig.MAX_RETRIES_RECEIPT_VALIDATION,
    RetryConfig.RECEIPT_VALIDATION_SUBSEQUENT_DELAY,
  ),
  failFastOnMadaraDown,
);

// Receipt validation for parallel processing (higher retry count)
// Uses failFastOnMadaraDown to preserve MadaraDownError type for recovery handling
export const parallelReceiptValidationRetry = new RetryExecutor(
  new FixedDelayStrategy(
    RetryConfig.MAX_RETRIES_RECEIPT_VALIDATION_PARALLEL,
    RetryConfig.RECEIPT_VALIDATION_SUBSEQUENT_DELAY,
  ),
  failFastOnMadaraDown,
);

// Block hash matching
// Uses failFastOnMadaraDown to preserve MadaraDownError type for recovery handling
export const blockHashRetry = new RetryExecutor(
  new ExponentialBackoffStrategy(
    RetryConfig.MAX_RETRIES_BLOCK_HASH,
    BlockProcessing.BLOCK_HASH_RETRY_BASE_DELAY,
    30000, // Max 30 seconds
  ),
  failFastOnMadaraDown,
);

// Transaction posting with fixed long delay
// Uses failFastOnMadaraDown to preserve MadaraDownError type for recovery handling
export const transactionPostRetry = new RetryExecutor(
  new FixedDelayStrategy(
    RetryConfig.MAX_RETRIES_TRANSACTION_POST,
    RetryConfig.BASE_DELAY_TRANSACTION_POST,
  ),
  failFastOnMadaraDown,
);
