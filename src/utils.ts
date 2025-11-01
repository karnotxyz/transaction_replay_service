import {
  BlockWithTxHashes,
  Contract,
  GetTransactionReceiptResponse,
  Provider,
  RpcProvider,
  BlockIdentifier,
  BlockTag,
  TransactionReceipt,
} from "starknet";
import ERC20 from "./contracts/ERC20.json" with { type: "json" };
import logger from "./logger.js";
import axios, { AxiosResponse } from "axios";
// import db from "./models/index.js";
import { MadaraRpcResponse } from "./types.js";
import { GasPrices } from "./types.js";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
const nonce_tracker: Record<string, number> = {};

// Custom error for Madara downtime
export class MadaraDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MadaraDownError";
  }
}

/**
 * Check if error indicates Madara is down
 */
export function isMadaraDownError(error: any): boolean {
  const errorMessage = error?.message?.toLowerCase() || "";
  const errorCode = error?.code?.toLowerCase() || "";
  const errorCause = error?.cause?.code?.toLowerCase() || "";

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
 * Check Madara health endpoint
 */
export async function checkMadaraHealth(): Promise<boolean> {
  try {
    const healthUrl = `${process.env.RPC_URL_SYNCING_NODE}/health`;
    const response = await axios.get(healthUrl, { timeout: 5000 });
    return response.status === 200 && response.data === "OK";
  } catch (error) {
    return false;
  }
}

/**
 * Wait for Madara to recover (max 1 day)
 * Returns true if recovered, false if timeout
 */
export async function waitForMadaraRecovery(): Promise<boolean> {
  const MAX_WAIT_TIME = 24 * 60 * 60 * 1000; // 1 day in milliseconds
  const startTime = Date.now();
  let attempt = 0;

  logger.warn("🚨 Madara node is down - starting recovery wait...");
  logger.info("⏳ Maximum wait time: 24 hours");

  while (Date.now() - startTime < MAX_WAIT_TIME) {
    attempt++;
    const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);

    logger.info(
      `🔍 Recovery attempt ${attempt} (elapsed: ${elapsedMinutes}m)...`,
    );

    const isHealthy = await checkMadaraHealth();

    if (isHealthy) {
      const recoveryTime = Date.now() - startTime;
      const recoveryMinutes = Math.floor(recoveryTime / 60000);
      logger.info(
        `✅ Madara recovered! (downtime: ${recoveryMinutes}m ${Math.floor((recoveryTime % 60000) / 1000)}s)`,
      );
      return true;
    }

    // Exponential backoff capped at 5 minutes
    const delay = Math.min(Math.pow(2, Math.min(attempt, 8)) * 1000, 300000);
    logger.debug(`⏸️  Madara still down, retrying in ${delay / 1000}s...`);

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  logger.error("❌ Madara recovery timeout - exceeded 24 hour wait period");
  return false;
}

/**
 * Returns the nonce for an address.
 * Special handling for address "0x1" with local nonce tracker.
 */
export async function getNonce(
  address: string,
  provider: RpcProvider,
  nonce: string,
): Promise<string> {
  if (address !== "0x1") {
    return nonce;
  }

  try {
    if (nonce_tracker[address] === undefined) {
      nonce_tracker[address] = Number(
        await provider.getNonceForAddress(address),
      );
    }

    const address_nonce = nonce_tracker[address];
    nonce_tracker[address] += 1;

    return `0x${address_nonce.toString(16)}`;
  } catch (error) {
    // Check if this is a Madara down error
    if (isMadaraDownError(error)) {
      throw new MadaraDownError(
        `Madara down while getting nonce for ${address}: ${error}`,
      );
    }
    throw error;
  }
}

/**
 * Get latest block number from provider.
 */
export async function getLatestBlockNumber(
  provider: RpcProvider,
): Promise<number> {
  const latestBlock: any = await provider.getBlockLatestAccepted();
  return latestBlock.block_number;
}

/**
 * Get pending block from provider.
 */
export async function getBlockWithTxHashes(
  provider: RpcProvider,
  block_number: number,
): Promise<BlockWithTxHashes> {
  let block_tag: BlockIdentifier = block_number;
  const pendingBlock = await provider.getBlockWithTxHashes(block_tag);
  return pendingBlock;
}

/**
 * Get pending block from provider.
 */
export async function getPreConfirmedBlock(
  provider: RpcProvider,
): Promise<BlockWithTxHashes> {
  let block_tag: BlockIdentifier = BlockTag.PRE_CONFIRMED;
  const pendingBlock = await provider.getBlockWithTxHashes(block_tag);
  return pendingBlock;
}

/**
 * Get pending block from provider.
 */
export async function getBlock(
  provider: RpcProvider,
  block_tag: BlockIdentifier,
): Promise<BlockWithTxHashes> {
  const block = await provider.getBlockWithTxHashes(block_tag);
  return block;
}

export async function getBlockTimestamp(
  provider: RpcProvider,
  block_number: number,
): Promise<number | null> {
  const maxRetries = 8; // 2^8 = 256 seconds max
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const latestBlock = await provider.getBlockWithTxHashes(block_number);

      // Check if it's a pending block
      if ("timestamp" in latestBlock && latestBlock.timestamp) {
        return latestBlock.timestamp;
      }

      // Return null for pending blocks
      return null;
    } catch (error) {
      retryCount++;

      if (retryCount > maxRetries) {
        throw new Error(
          `Failed to get block timestamp for block ${block_number} after ${maxRetries + 1} attempts (max 256s). Latest error: ${error}`,
        );
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s = 255s total
      const delay = Math.pow(2, retryCount) * 1000;
      logger.warn(
        `Failed to get block timestamp for block ${block_number} (attempt ${retryCount}), retrying in ${delay}ms:`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but satisfies TypeScript
  throw new Error("Unexpected end of retry loop");
}

export async function getGasPrices(
  provider: RpcProvider,
  block_number: number,
): Promise<GasPrices> {
  const maxRetries = 8; // 2^8 = 256 seconds max
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const block = await provider.getBlockWithTxHashes(block_number);

      // Check if it's a pending block
      if (!("block_hash" in block && block.block_hash)) {
        throw new Error(`Block ${block_number} is pending`);
      }

      // Extract gas prices
      return {
        l1_data_gas_price: block.l1_data_gas_price,
        l1_gas_price: block.l1_gas_price,
        // @ts-ignore
        l2_gas_price: block.l2_gas_price,
      };
    } catch (error) {
      retryCount++;

      if (retryCount > maxRetries) {
        throw new Error(
          `Failed to get gas prices for block ${block_number} after ${maxRetries + 1} attempts (max 256s). Latest error: ${error}`,
        );
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s = 255s total
      const delay = Math.pow(2, retryCount) * 1000;
      logger.warn(
        `Failed to get gas prices for block ${block_number} (attempt ${retryCount}), retrying in ${delay}ms:`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but satisfies TypeScript
  throw new Error("Unexpected end of retry loop");
}

export async function getBlockHash(
  provider: RpcProvider,
  block_number: number,
): Promise<string | null> {
  const maxRetries = 100; // 2^8 = 256 seconds max
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const latestBlock = await provider.getBlockWithTxHashes(block_number);

      // Check if it's a pending block
      if ("block_hash" in latestBlock && latestBlock.block_hash) {
        return latestBlock.block_hash;
      }

      // Return null for pending blocks
      return null;
    } catch (error) {
      retryCount++;

      if (retryCount > maxRetries) {
        throw new Error(
          `Failed to get block hash for block ${block_number} after ${maxRetries + 1} attempts (max 256s). Latest error: ${error}`,
        );
      }

      const delay = Math.pow(2, retryCount) * 50;
      logger.warn(
        `Failed to get block hash for block ${block_number} (attempt ${retryCount}), retrying in ${delay}ms:`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but satisfies TypeScript
  throw new Error("Unexpected end of retry loop");
}

export async function getBlockWithTxsWithRetry(
  provider: RpcProvider,
  block_number: number,
) {
  const maxRetries = 8; // 2^8 = 256 seconds max
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const blockWithTxs = await provider.getBlockWithTxs(block_number);
      return blockWithTxs;
    } catch (error) {
      retryCount++;

      if (retryCount > maxRetries) {
        throw new Error(
          `Failed to get block with transactions for block ${block_number} after ${maxRetries + 1} attempts (max 256s). Latest error: ${error}`,
        );
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s = 255s total
      const delay = Math.pow(2, retryCount) * 1000;
      logger.warn(
        `Failed to get block with transactions for block ${block_number} (attempt ${retryCount}), retrying in ${delay}ms:`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but satisfies TypeScript
  throw new Error("Unexpected end of retry loop");
}

// Get latest block number with extended retry logic (up to 256 seconds)
export async function getLatestBlockNumberWithRetry(): Promise<number> {
  const maxRetries = 8; // 2^8 = 256 seconds max
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      return await getLatestBlockNumber(syncingProvider_v9);
    } catch (error) {
      retryCount++;

      if (retryCount > maxRetries) {
        throw new Error(
          `Failed to get latest block number after ${maxRetries + 1} attempts (max 256s). Latest error: ${error}`,
        );
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s = 255s total
      const delay = Math.pow(2, retryCount) * 1000;
      logger.warn(
        `Failed to get latest block number (attempt ${retryCount}), retrying in ${delay}ms:`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but satisfies TypeScript
  throw new Error("Unexpected end of retry loop");
}

/**
 * Get receipt of a transaction.
 */
export async function getTransactionReceipt(
  provider: RpcProvider,
  transaction_hash: string,
): Promise<GetTransactionReceiptResponse> {
  try {
    const transactionReceipt =
      await provider.getTransactionReceipt(transaction_hash);
    return transactionReceipt;
  } catch (error) {
    // Check if this is a Madara down error at the provider level
    // Provider errors might not be wrapped yet
    if (
      isMadaraDownError(error) ||
      (error instanceof Error &&
        (error.message.includes("ECONNREFUSED") ||
          error.message.includes("fetch failed") ||
          error.message.includes("network")))
    ) {
      throw new MadaraDownError(
        `Madara down while getting receipt for ${transaction_hash}: ${error}`,
      );
    }
    throw error;
  }
}

export async function closeBlock(): Promise<void> {
  try {
    const response = await axios.post<MadaraRpcResponse>(
      process.env.ADMIN_RPC_URL_SYNCING_NODE!,
      {
        jsonrpc: "2.0",
        method: "madara_V0_1_0_closeBlock",
        id: 1,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    // Check for RPC errors
    if (response.data.error) {
      throw new Error(
        `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`,
      );
    }

    logger.info("Block closed successfully");
  } catch (error) {
    // Check if this is a Madara down error
    if (isMadaraDownError(error)) {
      throw new MadaraDownError(`Madara down while closing block: ${error}`);
    }
    logger.info("Error closing block:", error);
    throw error;
  }
}

export async function setCustomHeader(currentBlock: number): Promise<void> {
  try {
    const timestamp = await getBlockTimestamp(
      originalProvider_v9,
      currentBlock,
    );
    const expectedBlockHash = await getBlockHash(
      originalProvider_v9,
      currentBlock,
    );

    const gas_prices = await getGasPrices(originalProvider_v9, currentBlock);
    const response = await axios.post<MadaraRpcResponse>(
      process.env.ADMIN_RPC_URL_SYNCING_NODE!,
      {
        jsonrpc: "2.0",
        method: "madara_V0_1_0_setCustomBlockHeader",
        id: 1,
        params: [
          {
            block_n: currentBlock,
            timestamp: timestamp,
            gas_prices: {
              eth_l1_gas_price: parseInt(
                gas_prices.l1_gas_price.price_in_wei,
                16,
              ),
              strk_l1_gas_price: parseInt(
                gas_prices.l1_gas_price.price_in_fri,
                16,
              ),
              eth_l1_data_gas_price: parseInt(
                gas_prices.l1_data_gas_price.price_in_wei,
                16,
              ),
              strk_l1_data_gas_price: parseInt(
                gas_prices.l1_data_gas_price.price_in_fri,
                16,
              ),
              // The below two fields will change to 1 for 0.13.2 and 25000 for 0.13.5
              eth_l2_gas_price: parseInt(
                gas_prices.l2_gas_price.price_in_wei,
                16,
              ),
              strk_l2_gas_price: parseInt(
                gas_prices.l2_gas_price.price_in_fri,
                16,
              ),
            },
            expected_block_hash: expectedBlockHash,
          },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    // Check for RPC errors
    if (response.data.error) {
      throw new Error(
        `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`,
      );
    }

    logger.info("Custom headers set for block");
  } catch (error) {
    // Check if this is a Madara down error
    if (isMadaraDownError(error)) {
      throw new MadaraDownError(
        `Madara down while setting custom headers: ${error}`,
      );
    }
    logger.info("Error setting custom headers:", error);
    throw error;
  }
}

export async function postWithRetry(
  url: string,
  data: Record<string, any>,
): Promise<AxiosResponse<any>> {
  const MAX_ATTEMPTS = 3;
  const SLEEP = 30000;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const result = await axios.post(url, data);
      if (result.data.error && result.data.error.code === 55) {
        console.log(
          `Account validation failed, retrying in 30 seconds, result:`,
        );
        console.log(result.data);
        await new Promise((resolve) => setTimeout(resolve, SLEEP));
      } else {
        return result;
      }
    } catch (error) {
      // Check if this is a Madara down error
      if (isMadaraDownError(error)) {
        throw new MadaraDownError(
          `Madara down while posting to ${url}: ${error}`,
        );
      }
      throw error;
    }
  }
  throw new Error("Max retries exceeded for transaction");
}

// Process receipt validation for a single transaction with configurable retry logic
export async function validateTransactionReceipt(
  provider: RpcProvider,
  tx_hash: string,
  options: {
    maxRetries?: number;
    useExponentialBackoff?: boolean;
    fixedDelay?: number;
  } = {},
): Promise<void> {
  const {
    maxRetries = 20,
    useExponentialBackoff = false,
    fixedDelay = 100,
  } = options;

  let retryCount = 0;
  let consecutiveConnectionErrors = 0;
  const MAX_CONNECTION_ERRORS = 3; // Fail fast after 3 consecutive connection errors

  while (retryCount <= maxRetries) {
    try {
      logger.debug(
        `Getting receipt for transaction - ${tx_hash} (attempt ${retryCount + 1}/${maxRetries + 1})`,
      );

      const transactionReceipt = await getTransactionReceipt(provider, tx_hash);

      // Validate if the transaction was a success or not !
      if (!transactionReceipt.isSuccess() && !transactionReceipt.isReverted()) {
        throw new Error(`Transaction in unexpected state ${tx_hash}`);
      }

      // Success - exit the retry loop
      return;
    } catch (error) {
      // Check if this is a Madara down error - fail fast
      if (error instanceof MadaraDownError) {
        logger.warn(
          `🚨 Madara connection error detected while validating receipt for ${tx_hash}`,
        );
        throw error; // Propagate immediately
      }

      // Check if the underlying error is a connection error
      if (isMadaraDownError(error)) {
        consecutiveConnectionErrors++;
        logger.warn(
          `⚠️  Connection error ${consecutiveConnectionErrors}/${MAX_CONNECTION_ERRORS} while validating receipt for ${tx_hash}`,
        );

        if (consecutiveConnectionErrors >= MAX_CONNECTION_ERRORS) {
          logger.error(
            `❌ Too many consecutive connection errors (${consecutiveConnectionErrors}) - Madara likely down`,
          );
          throw new MadaraDownError(
            `Madara down while validating receipt for ${tx_hash} after ${consecutiveConnectionErrors} connection errors`,
          );
        }
      } else {
        // Reset connection error counter on non-connection errors
        consecutiveConnectionErrors = 0;
      }

      retryCount++;

      if (retryCount > maxRetries) {
        const errorMsg = `Failed to validate receipt for transaction ${tx_hash} after ${maxRetries} attempts. Latest error: ${error}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      // Calculate delay based on strategy
      const delay = useExponentialBackoff
        ? Math.pow(2, retryCount) * 1000 // Exponential backoff: 2s, 4s, 8s, 16s, 32s, etc.
        : fixedDelay; // Fixed delay

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function matchBlockHash(block_number: number): Promise<void> {
  const maxAttempts = 400;
  const baseDelay = 100; // 100 ms

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Calculate delay: 2^attempt * baseDelay (2s, 4s, 8s, 16s)
      const delay = Math.pow(2, attempt - 1) * baseDelay;
      logger.info(
        `Retrying in ${delay}ms... (attempt ${attempt}/${maxAttempts})`,
      );

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));

      const paradexBlock = await getBlockHash(
        originalProvider_v9,
        block_number,
      );
      logger.info(`Paradex block hash: ${paradexBlock}`);

      const madaraBlock = await getBlockHash(syncingProvider_v9, block_number);
      logger.info(`Madara block hash : ${madaraBlock}`);

      // Check if we failed to fetch either hash (null means block not finalized yet)
      if (!paradexBlock || !madaraBlock) {
        const errorMsg = `Failed to fetch block hash for block number ${block_number} (paradex: ${paradexBlock}, madara: ${madaraBlock})`;
        logger.warn(errorMsg);
        // This is a retriable error - block might not be finalized yet
        throw new Error(errorMsg);
      }

      // Both hashes retrieved successfully - now check if they match
      if (paradexBlock !== madaraBlock) {
        // This is NOT a retriable error - the hashes are different!
        const errorMsg = `❌ BLOCK HASH MISMATCH for block ${block_number}:\n  Paradex: ${paradexBlock}\n  Madara:  ${madaraBlock}`;
        // logger.error(errorMsg);
        logger.error(`🛑 This is a critical error - stopping sync immediately`);
        throw new Error(errorMsg);
      }

      // Success - hashes match
      logger.info(`✅ Block hash verified for block ${block_number}`);
      return;
    } catch (error) {
      // Check if this is a hash mismatch error (non-retriable)
      if (
        error instanceof Error &&
        error.message.includes("BLOCK HASH MISMATCH")
      ) {
        // Don't retry on hash mismatch - fail immediately
        logger.error(`❌ Hash mismatch detected - failing without retry`);
        throw error;
      }

      // This is a retriable error (failed to fetch hash)
      logger.warn(
        `Attempt ${attempt}/${maxAttempts} failed for block ${block_number}: ${error}`,
      );

      // If this was the last attempt, throw the error
      if (attempt === maxAttempts) {
        logger.error(
          `❌ All ${maxAttempts} attempts failed for block ${block_number}`,
        );
        throw error;
      }

      // Otherwise continue to next retry attempt
    }
  }
}
