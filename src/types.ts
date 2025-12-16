import { BlockIdentifier } from "starknet";
import { ProcessStatusType } from "./constants.js";

/**
 * Return type for sync bounds calculation
 */
export interface SyncBounds {
  syncFrom: number;
  syncTo: number;
  startTxIndex: number;
  alreadyComplete: boolean;
  needsBlockClose?: boolean;
  message: string;
}

/**
 * Process state management
 */
export interface SyncProcess {
  id: string;
  status: ProcessStatusType;
  syncFrom: number;
  syncTo: number;
  currentBlock: number;
  currentTxIndex: number;
  totalBlocks: number | null; // null for continuous sync
  processedBlocks: number;
  startTime: Date;
  endTime?: Date;
  error?: string;
  cancelRequested: boolean;
  completeCurrentBlock?: boolean;
  isContinuous?: boolean;
  originalTarget?: number;
}

/**
 * Sync state stored in file (replaces Redis)
 * Minimal state - recovery queries syncing node for current position
 */
export interface SyncState {
  status: "running" | "idle";
  syncTo: number | "latest" | null;
  isContinuous: boolean;
  updatedAt: string;
}

/**
 * Sync request
 */
export interface SyncRequest {
  endBlock: BlockIdentifier;
}

/**
 * Gas prices structure
 */
export interface GasPrices {
  l1_data_gas_price: {
    price_in_fri: string;
    price_in_wei: string;
  };
  l1_gas_price: {
    price_in_fri: string;
    price_in_wei: string;
  };
  l2_gas_price: {
    price_in_fri: string;
    price_in_wei: string;
  };
}

/**
 * Madara RPC response
 */
export interface MadaraRpcResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Retry options
 */
export interface RetryOptions {
  maxRetries?: number;
  useExponentialBackoff?: boolean;
  fixedDelay?: number;
}

/**
 * Transaction result
 */
export interface TransactionResult {
  txHash: string;
  success: boolean;
  error?: string;
}
