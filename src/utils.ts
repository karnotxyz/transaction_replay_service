/**
 * Legacy utils file - most functionality has been moved to specialized modules
 * This file is kept for backwards compatibility during migration
 */

// Re-export from new modules
export {
  getLatestBlockNumber,
  getBlockWithTxHashes,
  getPreConfirmedBlock,
  getBlock,
  getBlockTimestamp,
  getGasPrices,
  getBlockHash,
  setCustomHeader,
  closeBlock,
  matchBlockHash,
  getBlockWithTxs as getBlockWithTxsWithRetry,
} from "./operations/blockOperations.js";

export {
  getNonce,
  getTransactionReceipt,
  validateTransactionReceipt,
  validateBlockReceipts,
  postWithRetry,
} from "./operations/transactionOperations.js";

export {
  checkMadaraHealth,
  waitForMadaraRecovery,
  executeWithMadaraRecovery,
} from "./madara/index.js";

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

// Keep getLatestBlockNumberWithRetry for backwards compatibility
export { getLatestBlockNumber as getLatestBlockNumberWithRetry } from "./operations/blockOperations.js";
