/**
 * Retry Configuration
 */
export const RetryConfig = {
  // Maximum retry attempts for different operations
  MAX_RETRIES_BLOCK_FETCH: 8, // 2^8 = 256 seconds max
  MAX_RETRIES_RECEIPT_VALIDATION: 20,
  MAX_RETRIES_RECEIPT_VALIDATION_PARALLEL: 2000,
  MAX_RETRIES_BLOCK_VALIDATION: 5,
  MAX_RETRIES_BLOCK_HASH: 100,
  MAX_RETRIES_TRANSACTION_POST: 3,
  MAX_RETRIES_PROBE: 5,

  // Connection error thresholds
  MAX_CONSECUTIVE_CONNECTION_ERRORS: 3,

  // Base delays (in milliseconds)
  BASE_DELAY_EXPONENTIAL: 1000, // 1 second
  BASE_DELAY_FIXED: 100, // 100 milliseconds
  BASE_DELAY_TRANSACTION_POST: 30000, // 30 seconds

  // Special delays
  RECEIPT_VALIDATION_INITIAL_DELAY: 2000, // 2 seconds for first receipt
  RECEIPT_VALIDATION_SUBSEQUENT_DELAY: 100, // 100ms for subsequent receipts
} as const;

/**
 * Timeout Configuration
 */
export const TimeoutConfig = {
  // Madara recovery
  MADARA_RECOVERY_MAX_WAIT: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  MADARA_HEALTH_CHECK_TIMEOUT: 5000, // 5 seconds
} as const;

/**
 * Probe Configuration (for continuous sync)
 */
export const ProbeConfig = {
  INTERVAL_MS: 60 * 1000, // 1 minute
  CAUGHT_UP_WAIT_MS: 5000, // 5 seconds when caught up
} as const;

/**
 * Receipt Validation Configuration
 * Uses phased polling: fast initially, then slower over time
 */
export const ReceiptValidationConfig = {
  // Total timeout for receipt validation
  TIMEOUT_MS: 15 * 60 * 1000, // 15 minutes

  // Phase 1: Fast polling (first 5 seconds)
  PHASE1_DURATION_MS: 5000, // 5 seconds
  PHASE1_INTERVAL_MS: 100, // 100ms between polls

  // Phase 2: Medium polling (5 seconds to 1 minute)
  PHASE2_DURATION_MS: 60 * 1000, // 1 minute cumulative
  PHASE2_INTERVAL_MS: 500, // 500ms between polls

  // Phase 3: Slow polling (after 1 minute)
  PHASE3_INTERVAL_MS: 2000, // 2 seconds between polls

  // Initial delay before starting validation
  INITIAL_DELAY_MS: 500, // Wait 500ms before first poll
} as const;

/**
 * Block Processing Configuration
 */
export const BlockProcessing = {
  // Transaction delays
  TX_DELAY_BETWEEN_TXS: 100, // 100ms between transactions
  TX_DELAY_FIRST_RECEIPT: 2000, // 2 seconds for first receipt validation

  // Block hash matching
  BLOCK_HASH_RETRY_BASE_DELAY: 100, // 100ms base delay
  BLOCK_HASH_MAX_ATTEMPTS: 400,
} as const;

/**
 * Process Status
 */
export const ProcessStatus = {
  RUNNING: "running",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
  RECOVERING: "recovering",
} as const;

export type ProcessStatusType =
  (typeof ProcessStatus)[keyof typeof ProcessStatus];

/**
 * Sync Modes
 */
export const SyncMode = {
  SEQUENTIAL: "sequential",
  PARALLEL: "parallel",
  CONTINUOUS: "continuous",
} as const;

export type SyncModeType = (typeof SyncMode)[keyof typeof SyncMode];

/**
 * RPC Versions
 */
export const RpcVersion = {
  V0_8_1: "0.8.1",
  V0_9_0: "0.9.0",
} as const;

export type RpcVersionType = (typeof RpcVersion)[keyof typeof RpcVersion];

/**
 * RPC Version Paths
 */
export const RpcVersionPaths: Record<RpcVersionType, string> = {
  [RpcVersion.V0_8_1]: "/rpc/v0_8_1",
  [RpcVersion.V0_9_0]: "/rpc/v0_9",
} as const;

/**
 * HTTP Status Codes
 */
export const HttpStatus = {
  OK: 200,
  ACCEPTED: 202,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500,
} as const;

/**
 * Transaction Types
 */
export const TransactionType = {
  INVOKE: "INVOKE",
  DECLARE: "DECLARE",
  DEPLOY_ACCOUNT: "DEPLOY_ACCOUNT",
  L1_HANDLER: "L1_HANDLER",
} as const;

export type TransactionTypeType =
  (typeof TransactionType)[keyof typeof TransactionType];

/**
 * Transaction Versions
 */
export const TransactionVersion = {
  V0: "0x0",
  V1: "0x1",
  V2: "0x2",
  V3: "0x3",
} as const;

export type TransactionVersionType =
  (typeof TransactionVersion)[keyof typeof TransactionVersion];

/**
 * Error Codes
 */
export const ErrorCode = {
  SYNC_IN_PROGRESS: "SYNC_IN_PROGRESS",
  INVALID_BLOCK_NUMBER: "INVALID_BLOCK_NUMBER",
  INVALID_BLOCK_IDENTIFIER: "INVALID_BLOCK_IDENTIFIER",
  INVALID_BLOCK_TYPE: "INVALID_BLOCK_TYPE",
  BLOCK_NUMBER_TOO_LARGE: "BLOCK_NUMBER_TOO_LARGE",
  MADARA_DOWN: "MADARA_DOWN",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  BLOCK_HASH_MISMATCH: "BLOCK_HASH_MISMATCH",
  PROCESS_NOT_FOUND: "PROCESS_NOT_FOUND",
  INVALID_PROCESS_STATUS: "INVALID_PROCESS_STATUS",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Logging Configuration
 */
export const LogConfig = {
  USE_EMOJIS: true, // Set to false to disable emojis in logs
  STRUCTURED_LOGGING: false, // Set to true for JSON structured logs
} as const;

/**
 * L1 Handler Configuration
 */
export const L1HandlerConfig = {
  DEFAULT_PAID_FEE: 128328,
} as const;
