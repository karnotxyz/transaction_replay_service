import logger from "../logger.js";
import { RetryStrategy } from "./strategies.js";
import { MadaraDownError, isMadaraDownError } from "../errors/index.js";

export interface RetryContext {
  operation: string;
  currentAttempt: number;
  maxAttempts: number;
  lastError?: Error;
}

export type RetryPredicate = (error: any, context: RetryContext) => boolean;

/**
 * Default retry predicate - retry on any error
 */
const defaultRetryPredicate: RetryPredicate = () => true;

/**
 * Retry predicate that fails fast on Madara down errors
 */
export const failFastOnMadaraDown: RetryPredicate = (error: any) => {
  if (error instanceof MadaraDownError || isMadaraDownError(error)) {
    return false; // Don't retry, propagate immediately
  }
  return true;
};

/**
 * Retry executor that uses a strategy to determine retry behavior
 */
export class RetryExecutor {
  constructor(
    private readonly strategy: RetryStrategy,
    private readonly shouldRetry: RetryPredicate = defaultRetryPredicate,
  ) {}

  /**
   * Execute an operation with retry logic
   */
  async execute<T>(
    operation: () => Promise<T>,
    operationName: string = "operation",
  ): Promise<T> {
    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt <= this.strategy.getMaxRetries()) {
      try {
        if (attempt > 0) {
          logger.debug(
            `Retry attempt ${attempt}/${this.strategy.getMaxRetries()} for ${operationName}`,
          );
        }

        const result = await operation();

        if (attempt > 0) {
          logger.info(
            `✅ ${operationName} succeeded on attempt ${attempt + 1}`,
          );
        }

        return result;
      } catch (error) {
        lastError = error as Error;

        const context: RetryContext = {
          operation: operationName,
          currentAttempt: attempt,
          maxAttempts: this.strategy.getMaxRetries(),
          lastError,
        };

        // Check if we should retry this error
        if (!this.shouldRetry(error, context)) {
          logger.warn(
            `❌ ${operationName} failed with non-retryable error: ${lastError.message}`,
          );
          throw error;
        }

        const delay = this.strategy.getDelay(attempt);

        if (delay === null) {
          // No more retries
          logger.error(
            `❌ ${operationName} failed after ${attempt + 1} attempts. Last error: ${lastError.message}`,
          );
          throw new Error(
            `${operationName} failed after ${attempt + 1} attempts: ${lastError.message}`,
          );
        }

        logger.warn(
          `⚠️  ${operationName} failed (attempt ${attempt + 1}/${this.strategy.getMaxRetries() + 1}), retrying in ${delay}ms: ${lastError.message}`,
        );

        await this.sleep(delay);
        attempt++;
      }
    }

    // Should never reach here, but TypeScript requires it
    throw lastError || new Error(`${operationName} failed`);
  }

  /**
   * Execute with custom retry predicate
   */
  async executeWithPredicate<T>(
    operation: () => Promise<T>,
    predicate: RetryPredicate,
    operationName: string = "operation",
  ): Promise<T> {
    const executor = new RetryExecutor(this.strategy, predicate);
    return executor.execute(operation, operationName);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import {
  ExponentialBackoffStrategy,
  FixedDelayStrategy,
} from "./strategies.js";

/**
 * Create a retry executor with exponential backoff
 */
export function createExponentialRetry(
  maxRetries: number,
  baseDelay: number = 1000,
  maxDelay: number = 60000,
): RetryExecutor {
  return new RetryExecutor(
    new ExponentialBackoffStrategy(maxRetries, baseDelay, maxDelay),
  );
}

/**
 * Create a retry executor with fixed delay
 */
export function createFixedDelayRetry(
  maxRetries: number,
  delay: number,
): RetryExecutor {
  return new RetryExecutor(new FixedDelayStrategy(maxRetries, delay));
}
