import { ErrorCode, ErrorCodeType } from "../constants.js";

/**
 * Base error class for all application errors
 */
export class AppError extends Error {
  public readonly code: ErrorCodeType;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly timestamp: string;

  constructor(
    message: string,
    code: ErrorCodeType,
    statusCode: number = 500,
    isOperational: boolean = true,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Madara node is down or unreachable
 */
export class MadaraDownError extends AppError {
  constructor(message: string) {
    super(message, ErrorCode.MADARA_DOWN, 503, true);
  }
}

/**
 * Configuration error
 */
export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(message, ErrorCode.CONFIGURATION_ERROR, 500, false);
  }
}

/**
 * Sync already in progress
 */
export class SyncInProgressError extends AppError {
  public readonly details: any;

  constructor(message: string, details?: any) {
    super(message, ErrorCode.SYNC_IN_PROGRESS, 409, true);
    this.details = details;
  }
}

/**
 * Invalid block number
 */
export class InvalidBlockError extends AppError {
  constructor(
    message: string,
    code: ErrorCodeType = ErrorCode.INVALID_BLOCK_NUMBER,
  ) {
    super(message, code, 400, true);
  }
}

/**
 * Block hash mismatch
 */
export class BlockHashMismatchError extends AppError {
  public readonly originalNodeHash: string;
  public readonly syncingNodeHash: string;
  public readonly blockNumber: number;

  constructor(blockNumber: number, originalNodeHash: string, syncingNodeHash: string) {
    const message = `Block hash mismatch at block ${blockNumber}: Original=${originalNodeHash}, Syncing=${syncingNodeHash}`;
    super(message, ErrorCode.BLOCK_HASH_MISMATCH, 500, true);
    this.blockNumber = blockNumber;
    this.originalNodeHash = originalNodeHash;
    this.syncingNodeHash = syncingNodeHash;
  }
}

/**
 * Block Starknet version exceeds configured support ceiling
 */
export class UnsupportedStarknetVersionError extends AppError {
  public readonly blockNumber: number;
  public readonly blockVersion: string | null;
  public readonly maxSupportedVersion: string;

  constructor(
    blockNumber: number,
    blockVersion: string | null,
    maxSupportedVersion: string,
  ) {
    const message = blockVersion
      ? `Block ${blockNumber} uses Starknet version ${blockVersion}, which is higher than MAX_SUPPORTED_STARKNET_VERSION=${maxSupportedVersion}. Stopping replay.`
      : `Block ${blockNumber} does not expose starknet_version while MAX_SUPPORTED_STARKNET_VERSION=${maxSupportedVersion} is configured. Stopping replay.`;
    super(message, ErrorCode.UNSUPPORTED_STARKNET_VERSION, 409, true);
    this.blockNumber = blockNumber;
    this.blockVersion = blockVersion;
    this.maxSupportedVersion = maxSupportedVersion;
  }
}

/**
 * Process not found
 */
export class ProcessNotFoundError extends AppError {
  public readonly processId: string;

  constructor(processId: string) {
    super(
      `Process not found: ${processId}`,
      ErrorCode.PROCESS_NOT_FOUND,
      404,
      true,
    );
    this.processId = processId;
  }
}

/**
 * Invalid process status
 */
export class InvalidProcessStatusError extends AppError {
  public readonly processId: string;
  public readonly currentStatus: string;

  constructor(processId: string, currentStatus: string, message?: string) {
    super(
      message || `Invalid process status for ${processId}: ${currentStatus}`,
      ErrorCode.INVALID_PROCESS_STATUS,
      400,
      true,
    );
    this.processId = processId;
    this.currentStatus = currentStatus;
  }
}

/**
 * Check if an error indicates Madara is down
 */
export function isMadaraDownError(error: any): boolean {
  if (error instanceof MadaraDownError) {
    return true;
  }

  const errorMessage = String(error?.message ?? "").toLowerCase();
  const errorCode = String(error?.code ?? "").toLowerCase();
  const errorCause = String(error?.cause?.code ?? "").toLowerCase();

  return (
    errorMessage.includes("econnrefused") ||
    errorMessage.includes("could not reach") ||
    errorMessage.includes("couldn't reach") ||
    errorMessage.includes("network error") ||
    errorMessage.includes("connect econnrefused") ||
    errorMessage.includes("fetch failed") ||
    errorMessage.includes("enotfound") ||
    errorMessage.includes("socket hang up") ||
    errorMessage.includes("econnreset") ||
    errorCode === "econnrefused" ||
    errorCode === "enotfound" ||
    errorCode === "econnreset" ||
    errorCause === "econnrefused" ||
    errorCause === "enotfound" ||
    errorCause === "econnreset"
  );
}

/**
 * Wrap potential Madara errors
 */
export function wrapMadaraError(error: any, context: string): Error {
  if (isMadaraDownError(error)) {
    return new MadaraDownError(`${context}: ${error.message || error}`);
  }
  return error;
}
