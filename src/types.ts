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

/**
 * Transaction receipt from getBlockWithReceipts
 */
export interface TransactionReceipt {
  transaction_hash: string;
  actual_fee: {
    amount: string;
    unit: string;
  };
  execution_status: "SUCCEEDED" | "REVERTED";
  finality_status: string;
  type: string;
  messages_sent: any[];
  events: any[];
  execution_resources?: any;
  revert_reason?: string;
}

/**
 * Transaction with receipt from getBlockWithReceipts
 */
export interface TransactionWithReceipt {
  transaction: any;
  receipt: TransactionReceipt;
}

/**
 * Block with receipts response
 */
export interface BlockWithReceipts {
  block_hash?: string;
  block_number?: number;
  parent_hash?: string;
  timestamp?: number;
  sequencer_address?: string;
  l1_gas_price?: any;
  l1_data_gas_price?: any;
  l2_gas_price?: any;
  starknet_version?: string;
  transactions: TransactionWithReceipt[];
}
