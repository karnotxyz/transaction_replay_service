import logger from "../logger.js";

/**
 * Retry strategy interface
 */
export interface RetryStrategy {
  /**
   * Calculate delay for the next retry attempt
   * @param attempt - Current attempt number (0-indexed)
   * @returns Delay in milliseconds, or null to stop retrying
   */
  getDelay(attempt: number): number | null;

  /**
   * Get the maximum number of retries
   */
  getMaxRetries(): number;

  /**
   * Get a description of the strategy
   */
  getDescription(): string;
}

/**
 * Exponential backoff strategy
 * Delay = baseDelay * (2 ^ attempt), capped at maxDelay
 */
export class ExponentialBackoffStrategy implements RetryStrategy {
  constructor(
    private readonly maxRetries: number,
    private readonly baseDelay: number = 1000,
    private readonly maxDelay: number = 60000,
  ) {}

  getDelay(attempt: number): number | null {
    if (attempt >= this.maxRetries) {
      return null;
    }

    const delay = Math.min(
      this.baseDelay * Math.pow(2, attempt),
      this.maxDelay,
    );
    return delay;
  }

  getMaxRetries(): number {
    return this.maxRetries;
  }

  getDescription(): string {
    return `Exponential backoff (base: ${this.baseDelay}ms, max: ${this.maxDelay}ms, attempts: ${this.maxRetries})`;
  }
}

/**
 * Fixed delay strategy
 * Always uses the same delay between retries
 */
export class FixedDelayStrategy implements RetryStrategy {
  constructor(
    private readonly maxRetries: number,
    private readonly delay: number,
  ) {}

  getDelay(attempt: number): number | null {
    if (attempt >= this.maxRetries) {
      return null;
    }
    return this.delay;
  }

  getMaxRetries(): number {
    return this.maxRetries;
  }

  getDescription(): string {
    return `Fixed delay (${this.delay}ms, attempts: ${this.maxRetries})`;
  }
}

/**
 * Linear backoff strategy
 * Delay increases linearly: baseDelay * attempt
 */
export class LinearBackoffStrategy implements RetryStrategy {
  constructor(
    private readonly maxRetries: number,
    private readonly baseDelay: number = 1000,
    private readonly maxDelay: number = 30000,
  ) {}

  getDelay(attempt: number): number | null {
    if (attempt >= this.maxRetries) {
      return null;
    }

    const delay = Math.min(this.baseDelay * (attempt + 1), this.maxDelay);
    return delay;
  }

  getMaxRetries(): number {
    return this.maxRetries;
  }

  getDescription(): string {
    return `Linear backoff (base: ${this.baseDelay}ms, max: ${this.maxDelay}ms, attempts: ${this.maxRetries})`;
  }
}

/**
 * No retry strategy - fails immediately
 */
export class NoRetryStrategy implements RetryStrategy {
  getDelay(attempt: number): number | null {
    return null;
  }

  getMaxRetries(): number {
    return 0;
  }

  getDescription(): string {
    return "No retry";
  }
}
