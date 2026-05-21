import {
  PreConfirmedValidationConfig,
  ReceiptValidationConfig,
  SourceBlockPrefetchConfig,
} from "./constants.js";

export interface ReplayTimingConfig {
  preConfirmedPollIntervalMs: number;
  preConfirmedValidationTimeoutMs: number;
  receiptValidationInitialDelayMs: number;
  receiptValidationPhase1IntervalMs: number;
  sourceBlockPrefetchCount: number;
}

function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number,
  varName: string,
): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${varName} value: ${value}. Expected a positive integer.`,
    );
  }

  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  defaultValue: number,
  varName: string,
): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid ${varName} value: ${value}. Expected a non-negative integer.`,
    );
  }

  return parsed;
}

export function resolveReplayTimingConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReplayTimingConfig {
  return {
    preConfirmedPollIntervalMs: parsePositiveInteger(
      env.PRE_CONFIRMED_POLL_INTERVAL_MS,
      PreConfirmedValidationConfig.POLL_INTERVAL_MS,
      "PRE_CONFIRMED_POLL_INTERVAL_MS",
    ),
    preConfirmedValidationTimeoutMs: parsePositiveInteger(
      env.PRE_CONFIRMED_VALIDATION_TIMEOUT_MS,
      PreConfirmedValidationConfig.TIMEOUT_MS,
      "PRE_CONFIRMED_VALIDATION_TIMEOUT_MS",
    ),
    receiptValidationInitialDelayMs: parseNonNegativeInteger(
      env.RECEIPT_VALIDATION_INITIAL_DELAY_MS,
      ReceiptValidationConfig.INITIAL_DELAY_MS,
      "RECEIPT_VALIDATION_INITIAL_DELAY_MS",
    ),
    receiptValidationPhase1IntervalMs: parsePositiveInteger(
      env.RECEIPT_VALIDATION_PHASE1_INTERVAL_MS,
      ReceiptValidationConfig.PHASE1_INTERVAL_MS,
      "RECEIPT_VALIDATION_PHASE1_INTERVAL_MS",
    ),
    sourceBlockPrefetchCount: parseNonNegativeInteger(
      env.SOURCE_BLOCK_PREFETCH_COUNT,
      SourceBlockPrefetchConfig.PREFETCH_COUNT,
      "SOURCE_BLOCK_PREFETCH_COUNT",
    ),
  };
}
