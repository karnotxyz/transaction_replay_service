/**
 * Re-exports for commonly used utilities
 * Provides a convenient single import point
 */

// Block operations
export {
  getLatestBlockNumber,
  getBlockWithTxHashes,
  getBlockWithTxs,
  getBlockWithReceipts,
  getPreConfirmedBlock,
  setCustomHeader,
  closeBlock,
  matchBlockHash,
} from "./operations/blockOperations.js";

// Transaction operations
export {
  getNonce,
  getTransactionReceipt,
  validateBlockReceipts,
  postWithRetry,
} from "./operations/transactionOperations.js";

// Madara utilities
export {
  checkMadaraHealth,
  waitForMadaraRecovery,
  executeWithMadaraRecovery,
} from "./madara/index.js";

// Error types
export {
  MadaraDownError,
  isMadaraDownError,
  wrapMadaraError,
  AppError,
  ConfigurationError,
  SyncInProgressError,
  InvalidBlockError,
  BlockHashMismatchError,
  ProcessNotFoundError,
  InvalidProcessStatusError,
} from "./errors/index.js";
