import { BlockIdentifier } from "starknet";

// Return type for clarity
export interface SyncBounds {
  syncFrom: number;
  syncTo: number;
  startTxIndex: number;
  alreadyComplete: boolean;
  needsBlockClose?: boolean;
  message: string;
}

// Process state management
export interface SyncProcess {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed";
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
}

export interface StoredSyncProcess {
  processId: string;
  syncFrom: number;
  syncTo: number;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  lastChecked: string;
}

export interface SyncRequest {
  endBlock: BlockIdentifier;
}

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

export interface MadaraRpcResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}
