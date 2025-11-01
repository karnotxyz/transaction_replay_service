import {
  BlockWithTxHashes,
  // BlockWithTxs,
  RpcProvider,
  BlockIdentifier,
  BlockTag,
} from "starknet";
import logger from "../logger.js";
import { GasPrices, MadaraRpcResponse } from "../types.js";
import { blockFetchRetry, blockHashRetry } from "../retry/index.js";
import { wrapMadaraError, BlockHashMismatchError } from "../errors/index.js";
import { config } from "../config.js";
import axios from "axios";
import { originalProvider_v9, syncingProvider_v9 } from "../providers.js";

/**
 * Get latest block number from provider
 */
export async function getLatestBlockNumber(
  provider: RpcProvider,
): Promise<number> {
  return blockFetchRetry.execute(async () => {
    try {
      const latestBlock: any = await provider.getBlockLatestAccepted();
      return latestBlock.block_number;
    } catch (error) {
      throw wrapMadaraError(error, "getLatestBlockNumber");
    }
  }, "getLatestBlockNumber");
}

/**
 * Get block with transaction hashes
 */
export async function getBlockWithTxHashes(
  provider: RpcProvider,
  blockNumber: number,
): Promise<BlockWithTxHashes> {
  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(blockNumber);
      return block;
    } catch (error) {
      throw wrapMadaraError(error, `getBlockWithTxHashes(${blockNumber})`);
    }
  }, `getBlockWithTxHashes(${blockNumber})`);
}

/**
 * Get PRE_CONFIRMED block
 */
export async function getPreConfirmedBlock(
  provider: RpcProvider,
): Promise<BlockWithTxHashes> {
  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(BlockTag.PRE_CONFIRMED);
      return block;
    } catch (error) {
      throw wrapMadaraError(error, "getPreConfirmedBlock");
    }
  }, "getPreConfirmedBlock");
}

/**
 * Get block with transaction details
 */
export async function getBlockWithTxs(
  provider: RpcProvider,
  blockNumber: number,
): Promise<any> {
  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxs(blockNumber);
      return block;
    } catch (error) {
      throw wrapMadaraError(error, `getBlockWithTxs(${blockNumber})`);
    }
  }, `getBlockWithTxs(${blockNumber})`);
}

/**
 * Get block by block identifier
 */
export async function getBlock(
  provider: RpcProvider,
  blockTag: BlockIdentifier,
): Promise<BlockWithTxHashes> {
  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(blockTag);
      return block;
    } catch (error) {
      throw wrapMadaraError(error, `getBlock(${blockTag})`);
    }
  }, `getBlock(${blockTag})`);
}

/**
 * Get block timestamp
 */
export async function getBlockTimestamp(
  provider: RpcProvider,
  blockNumber: number,
): Promise<number | null> {
  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(blockNumber);

      if ("timestamp" in block && block.timestamp) {
        return block.timestamp;
      }

      return null; // Pending block
    } catch (error) {
      throw wrapMadaraError(error, `getBlockTimestamp(${blockNumber})`);
    }
  }, `getBlockTimestamp(${blockNumber})`);
}

/**
 * Get gas prices for a block
 */
export async function getGasPrices(
  provider: RpcProvider,
  blockNumber: number,
): Promise<GasPrices> {
  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(blockNumber);

      if (!("block_hash" in block && block.block_hash)) {
        throw new Error(`Block ${blockNumber} is pending`);
      }

      return {
        l1_data_gas_price: block.l1_data_gas_price,
        l1_gas_price: block.l1_gas_price,
        // @ts-ignore - l2_gas_price exists in the block
        l2_gas_price: block.l2_gas_price,
      };
    } catch (error) {
      throw wrapMadaraError(error, `getGasPrices(${blockNumber})`);
    }
  }, `getGasPrices(${blockNumber})`);
}

/**
 * Get block hash
 */
export async function getBlockHash(
  provider: RpcProvider,
  blockNumber: number,
): Promise<string | null> {
  return blockHashRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(blockNumber);

      if ("block_hash" in block && block.block_hash) {
        return block.block_hash;
      }

      return null; // Pending block
    } catch (error) {
      throw wrapMadaraError(error, `getBlockHash(${blockNumber})`);
    }
  }, `getBlockHash(${blockNumber})`);
}

/**
 * Set custom block header (Madara-specific)
 */
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
    const gasPrices = await getGasPrices(originalProvider_v9, currentBlock);

    const response = await axios.post<MadaraRpcResponse>(
      config.adminRpcUrlSyncingNode,
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
                gasPrices.l1_gas_price.price_in_wei,
                16,
              ),
              strk_l1_gas_price: parseInt(
                gasPrices.l1_gas_price.price_in_fri,
                16,
              ),
              eth_l1_data_gas_price: parseInt(
                gasPrices.l1_data_gas_price.price_in_wei,
                16,
              ),
              strk_l1_data_gas_price: parseInt(
                gasPrices.l1_data_gas_price.price_in_fri,
                16,
              ),
              eth_l2_gas_price: parseInt(
                gasPrices.l2_gas_price.price_in_wei,
                16,
              ),
              strk_l2_gas_price: parseInt(
                gasPrices.l2_gas_price.price_in_fri,
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

    if (response.data.error) {
      throw new Error(
        `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`,
      );
    }

    logger.info(`✅ Custom headers set for block ${currentBlock}`);
  } catch (error) {
    throw wrapMadaraError(error, `setCustomHeader(${currentBlock})`);
  }
}

/**
 * Close block (Madara-specific)
 */
export async function closeBlock(): Promise<void> {
  try {
    const response = await axios.post<MadaraRpcResponse>(
      config.adminRpcUrlSyncingNode,
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

    if (response.data.error) {
      throw new Error(
        `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`,
      );
    }

    logger.info("✅ Block closed successfully");
  } catch (error) {
    throw wrapMadaraError(error, "closeBlock");
  }
}

/**
 * Match block hashes between original and syncing nodes
 */
export async function matchBlockHash(blockNumber: number): Promise<void> {
  const originalProvider = originalProvider_v9;
  const syncingProvider = syncingProvider_v9;

  // Use retry logic with special handling for hash mismatch
  let attempts = 0;
  const maxAttempts = 400;

  while (attempts < maxAttempts) {
    attempts++;

    if (attempts > 1) {
      const delay = Math.pow(2, attempts - 1) * 100;
      logger.info(
        `Retrying block hash match in ${delay}ms... (attempt ${attempts}/${maxAttempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const paradexHash = await getBlockHash(originalProvider, blockNumber);
      logger.info(`Paradex block hash: ${paradexHash}`);

      const madaraHash = await getBlockHash(syncingProvider, blockNumber);
      logger.info(`Madara block hash: ${madaraHash}`);

      // Check if we failed to fetch either hash
      if (!paradexHash || !madaraHash) {
        const errorMsg = `Failed to fetch block hash for block ${blockNumber} (paradex: ${paradexHash}, madara: ${madaraHash})`;
        logger.warn(errorMsg);
        // This is retriable - block might not be finalized yet
        continue;
      }

      // Both hashes retrieved - check if they match
      if (paradexHash !== madaraHash) {
        // Hash mismatch is NOT retriable - fail immediately
        throw new BlockHashMismatchError(blockNumber, paradexHash, madaraHash);
      }

      // Success
      logger.info(`✅ Block hash verified for block ${blockNumber}`);
      return;
    } catch (error) {
      // If it's a hash mismatch error, don't retry
      if (error instanceof BlockHashMismatchError) {
        logger.error(
          `❌ Block hash mismatch detected at block ${blockNumber} - failing without retry`,
        );
        throw error;
      }

      // For other errors, check if we've exhausted retries
      if (attempts >= maxAttempts) {
        logger.error(
          `❌ All ${maxAttempts} attempts failed for block ${blockNumber}`,
        );
        throw error;
      }

      // Otherwise, log and continue to next attempt
      logger.warn(
        `Attempt ${attempts}/${maxAttempts} failed for block ${blockNumber}: ${error}`,
      );
    }
  }

  throw new Error(
    `Failed to match block hash for block ${blockNumber} after ${maxAttempts} attempts`,
  );
}
