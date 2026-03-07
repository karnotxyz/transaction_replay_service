import {
  BlockWithTxHashes,
  RpcProvider,
  BlockIdentifier,
  BlockTag,
} from "starknet";
import logger from "../logger.js";
import {
  GasPrices,
  MadaraRpcResponse,
  BlockWithReceipts,
  ReplayBoundaryStatus,
} from "../types.js";
import { blockFetchRetry, blockHashRetry } from "../retry/index.js";
import { wrapMadaraError, BlockHashMismatchError } from "../errors/index.js";
import { config } from "../config.js";
import axios from "axios";
import { rpcHttpClient } from "../rpcClient.js";
import {
  originalProvider_v9,
  syncingProvider_v9,
  getNodeName,
  getOriginalUserRpcUrl,
  getSyncingUserRpcUrl,
} from "../providers.js";
import {
  recordBlockProcessingDuration,
  recordBoundaryWait,
  startTimer,
  updateOriginalNodeBlockNumber,
  updateSyncingNodeBlockNumber,
  recordBlockStatus,
  incrementErrors,
} from "../telemetry/metrics.js";

/**
 * Get latest block number from provider
 */
export async function getLatestBlockNumber(
  provider: RpcProvider
): Promise<number> {
  const nodeName = getNodeName(provider);

  return blockFetchRetry.execute(async () => {
    try {
      const latestBlock: any = await provider.getBlockLatestAccepted();
      const blockNumber = latestBlock.block_number;

      // Update metrics based on which provider this is
      if (provider === originalProvider_v9) {
        updateOriginalNodeBlockNumber(blockNumber);
      } else if (provider === syncingProvider_v9) {
        updateSyncingNodeBlockNumber(blockNumber);
      }

      return blockNumber;
    } catch (error) {
      throw wrapMadaraError(error, `getLatestBlockNumber [${nodeName}]`);
    }
  }, `getLatestBlockNumber [${nodeName}]`);
}

/**
 * Get block with transaction hashes
 */
export async function getBlockWithTxHashes(
  provider: RpcProvider,
  blockNumber: number
): Promise<BlockWithTxHashes> {
  const nodeName = getNodeName(provider);

  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(blockNumber);
      return block;
    } catch (error) {
      throw wrapMadaraError(
        error,
        `getBlockWithTxHashes(${blockNumber}) [${nodeName}]`
      );
    }
  }, `getBlockWithTxHashes(${blockNumber}) [${nodeName}]`);
}

/**
 * Get PRE_CONFIRMED block
 */
export async function getPreConfirmedBlock(
  provider: RpcProvider
): Promise<BlockWithTxHashes> {
  const nodeName = getNodeName(provider);

  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(BlockTag.PRE_CONFIRMED);
      return block;
    } catch (error) {
      throw wrapMadaraError(error, `getPreConfirmedBlock [${nodeName}]`);
    }
  }, `getPreConfirmedBlock [${nodeName}]`);
}

/**
 * Get block with transaction details
 */
export async function getBlockWithTxs(
  provider: RpcProvider,
  blockNumber: number
): Promise<any> {
  const nodeName = getNodeName(provider);

  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxs(blockNumber);
      return block;
    } catch (error) {
      throw wrapMadaraError(
        error,
        `getBlockWithTxs(${blockNumber}) [${nodeName}]`
      );
    }
  }, `getBlockWithTxs(${blockNumber}) [${nodeName}]`);
}

/**
 * Get original block with transaction details and proof facts from the v0.10 route.
 */
export async function getOriginalBlockWithTxsAndProofFacts(
  blockNumber: number,
): Promise<any> {
  const rpcUrl = getOriginalUserRpcUrl();

  return blockFetchRetry.execute(async () => {
    try {
      const response = await axios.post(
        rpcUrl,
        {
          jsonrpc: "2.0",
          method: "starknet_getBlockWithTxs",
          params: [{ block_number: blockNumber }, ["INCLUDE_PROOF_FACTS"]],
          id: 1,
        },
        {
          headers: { "Content-Type": "application/json" },
        },
      );

      if (response.data.error) {
        throw new Error(
          `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`,
        );
      }

      return response.data.result;
    } catch (error) {
      throw wrapMadaraError(
        error,
        `getOriginalBlockWithTxsAndProofFacts(${blockNumber}) [original]`,
      );
    }
  }, `getOriginalBlockWithTxsAndProofFacts(${blockNumber}) [original]`);
}

/**
 * Get block with all transaction receipts (single RPC call)
 * This is much more efficient than fetching individual receipts
 */
export async function getBlockWithReceipts(
  provider: RpcProvider,
  blockNumber: number
): Promise<BlockWithReceipts | null> {
  const nodeName = getNodeName(provider);

  try {
    // Get the RPC URL from the provider
    const rpcUrl =
      provider === syncingProvider_v9
        ? getSyncingUserRpcUrl()
        : getOriginalUserRpcUrl();

    const response = await rpcHttpClient.post(
      rpcUrl,
      {
        jsonrpc: "2.0",
        method: "starknet_getBlockWithReceipts",
        params: [{ block_number: blockNumber }],
        id: 1,
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    if (response.data.error) {
      // Block not ready yet - return null to signal retry needed
      if (
        response.data.error.code === 24 ||
        response.data.error.message?.includes("Block not found")
      ) {
        return null;
      }
      throw new Error(
        `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`
      );
    }

    return response.data.result as BlockWithReceipts;
  } catch (error) {
    // Connection errors should be retried
    if (axios.isAxiosError(error) && !error.response) {
      logger.warn(
        `Connection error fetching block with receipts [${nodeName}]: ${error.message}`
      );
      return null;
    }
    throw wrapMadaraError(
      error,
      `getBlockWithReceipts(${blockNumber}) [${nodeName}]`
    );
  }
}

/**
 * Get block by block identifier
 */
export async function getBlock(
  provider: RpcProvider,
  blockTag: BlockIdentifier
): Promise<BlockWithTxHashes> {
  const nodeName = getNodeName(provider);

  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(blockTag);
      return block;
    } catch (error) {
      throw wrapMadaraError(error, `getBlock(${blockTag}) [${nodeName}]`);
    }
  }, `getBlock(${blockTag}) [${nodeName}]`);
}

/**
 * Get block timestamp
 */
export async function getBlockTimestamp(
  provider: RpcProvider,
  blockNumber: number
): Promise<number | null> {
  const nodeName = getNodeName(provider);

  return blockFetchRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(blockNumber);

      if ("timestamp" in block && block.timestamp) {
        return block.timestamp;
      }

      return null; // Pending block
    } catch (error) {
      throw wrapMadaraError(
        error,
        `getBlockTimestamp(${blockNumber}) [${nodeName}]`
      );
    }
  }, `getBlockTimestamp(${blockNumber}) [${nodeName}]`);
}

/**
 * Get gas prices for a block
 */
export async function getGasPrices(
  provider: RpcProvider,
  blockNumber: number
): Promise<GasPrices> {
  const nodeName = getNodeName(provider);

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
      throw wrapMadaraError(
        error,
        `getGasPrices(${blockNumber}) [${nodeName}]`
      );
    }
  }, `getGasPrices(${blockNumber}) [${nodeName}]`);
}

/**
 * Get block hash
 */
export async function getBlockHash(
  provider: RpcProvider,
  blockNumber: number
): Promise<string | null> {
  const nodeName = getNodeName(provider);

  return blockHashRetry.execute(async () => {
    try {
      const block = await provider.getBlockWithTxHashes(blockNumber);

      if ("block_hash" in block && block.block_hash) {
        return block.block_hash;
      }

      return null; // Pending block
    } catch (error) {
      throw wrapMadaraError(
        error,
        `getBlockHash(${blockNumber}) [${nodeName}]`
      );
    }
  }, `getBlockHash(${blockNumber}) [${nodeName}]`);
}

/**
 * Set custom block header (Madara-specific)
 * Optimized to fetch block data once instead of 3 separate calls
 */
export async function setCustomHeader(currentBlock: number): Promise<void> {
  const endTimer = startTimer();
  try {
    // Single fetch for all block data (was 3 separate calls before)
    const block = await getBlockWithTxHashes(originalProvider_v9, currentBlock);

    // Extract timestamp
    const timestamp = "timestamp" in block ? block.timestamp : null;

    // Extract block hash
    const expectedBlockHash =
      "block_hash" in block && block.block_hash ? block.block_hash : null;

    // Extract gas prices
    if (!("block_hash" in block && block.block_hash)) {
      throw new Error(`Block ${currentBlock} is pending - cannot set headers`);
    }

    const gasPrices: GasPrices = {
      l1_data_gas_price: block.l1_data_gas_price,
      l1_gas_price: block.l1_gas_price,
      // @ts-ignore - l2_gas_price exists in the block
      l2_gas_price: block.l2_gas_price,
    };

    const response = await rpcHttpClient.post<MadaraRpcResponse>(
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
                16
              ),
              strk_l1_gas_price: parseInt(
                gasPrices.l1_gas_price.price_in_fri,
                16
              ),
              eth_l1_data_gas_price: parseInt(
                gasPrices.l1_data_gas_price.price_in_wei,
                16
              ),
              strk_l1_data_gas_price: parseInt(
                gasPrices.l1_data_gas_price.price_in_fri,
                16
              ),
              eth_l2_gas_price: parseInt(
                gasPrices.l2_gas_price.price_in_wei,
                16
              ),
              strk_l2_gas_price: parseInt(
                gasPrices.l2_gas_price.price_in_fri,
                16
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
      }
    );

    if (response.data.error) {
      throw new Error(
        `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`
      );
    }

    logger.info(`✅ Custom headers set for block ${currentBlock}`);
    recordBlockProcessingDuration("set_header", endTimer());
  } catch (error) {
    incrementErrors("set_custom_header_error", "setCustomHeader");
    throw wrapMadaraError(error, `setCustomHeader(${currentBlock}) [syncing]`);
  }
}

/**
 * Set replay boundary metadata for a block on Madara.
 */
export async function setReplayBoundary(
  currentBlock: number,
  expectedTxCount: number,
  lastTxHash: string
): Promise<ReplayBoundaryStatus> {
  try {
    const response = await rpcHttpClient.post<MadaraRpcResponse>(
      config.adminRpcUrlSyncingNode,
      {
        jsonrpc: "2.0",
        method: "madara_V0_1_0_setReplayBoundary",
        id: 1,
        params: [
          {
            block_n: currentBlock,
            expected_tx_count: expectedTxCount,
            last_tx_hash: lastTxHash,
          },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.error) {
      throw new Error(
        `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`
      );
    }

    const status = response.data.result as ReplayBoundaryStatus;
    logger.info(
      `✅ Replay boundary set for block ${currentBlock} (expected_tx_count=${expectedTxCount}, last_tx_hash=${lastTxHash})`
    );
    return status;
  } catch (error) {
    incrementErrors("set_replay_boundary_error", "setReplayBoundary");
    throw wrapMadaraError(
      error,
      `setReplayBoundary(${currentBlock}) [syncing]`
    );
  }
}

/**
 * Get replay boundary status for a block from Madara.
 */
export async function getReplayBoundaryStatus(
  blockNumber: number
): Promise<ReplayBoundaryStatus | null> {
  try {
    const response = await rpcHttpClient.post<MadaraRpcResponse>(
      config.adminRpcUrlSyncingNode,
      {
        jsonrpc: "2.0",
        method: "madara_V0_1_0_getReplayBoundaryStatus",
        id: 1,
        params: [blockNumber],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.error) {
      throw new Error(
        `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`
      );
    }

    if (response.data.result == null) {
      return null;
    }

    return response.data.result as ReplayBoundaryStatus;
  } catch (error) {
    throw wrapMadaraError(
      error,
      `getReplayBoundaryStatus(${blockNumber}) [syncing]`
    );
  }
}

/**
 * Wait until Madara reports the replay boundary block is closed and boundary matched.
 */
export async function waitForReplayBoundaryClose(
  blockNumber: number,
  maxAttempts: number = 4000,
  delayMs: number = 100,
  shouldAbort?: () => boolean
): Promise<ReplayBoundaryStatus> {
  const endTimer = startTimer();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (shouldAbort?.()) {
      throw new Error(`Replay boundary wait aborted for block ${blockNumber}`);
    }

    const status = await getReplayBoundaryStatus(blockNumber);

    if (!status) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    if (status.mismatch) {
      throw new Error(
        `Replay boundary mismatch for block ${blockNumber}: ${status.mismatch}`
      );
    }

    if (status.closed) {
      if (!status.boundary_met) {
        throw new Error(
          `Replay boundary for block ${blockNumber} closed without boundary match`
        );
      }
      const durationSeconds = endTimer();
      recordBlockProcessingDuration("wait_boundary_close", durationSeconds);
      recordBoundaryWait(durationSeconds, attempt);
      logger.info(
        `✅ Replay boundary closed for block ${blockNumber} (executed=${status.executed_tx_count}/${status.expected_tx_count})`
      );
      return status;
    }

    if (attempt % 50 === 0) {
      logger.info(
        `⏳ Waiting replay boundary close for block ${blockNumber}: executed=${status.executed_tx_count}/${status.expected_tx_count}, closed=${status.closed}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(
    `Timed out waiting for replay boundary close for block ${blockNumber} after ${maxAttempts} attempts`
  );
}

/**
 * Close block (Madara-specific)
 */
export async function closeBlock(): Promise<void> {
  const endTimer = startTimer();
  try {
    const response = await rpcHttpClient.post<MadaraRpcResponse>(
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
      }
    );

    if (response.data.error) {
      throw new Error(
        `RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`
      );
    }

    logger.info("✅ Block closed successfully");
    recordBlockProcessingDuration("close_block", endTimer());
  } catch (error) {
    incrementErrors("close_block_error", "closeBlock");
    throw wrapMadaraError(error, "closeBlock [syncing]");
  }
}

/**
 * Match block hashes between original and syncing nodes
 */
export async function matchBlockHash(
  blockNumber: number,
  shouldAbort?: () => boolean
): Promise<void> {
  const endTimer = startTimer();

  // Use retry logic with special handling for hash mismatch
  let attempts = 0;
  const maxAttempts = 400;
  const maxDelayMs = 30000; // Cap delay at 30 seconds

  while (attempts < maxAttempts) {
    attempts++;

    if (shouldAbort?.()) {
      throw new Error(`Block hash matching aborted for block ${blockNumber}`);
    }

    if (attempts > 1) {
      // Exponential backoff with cap to prevent overflow
      const delay = Math.min(Math.pow(2, attempts - 1) * 100, maxDelayMs);
      logger.info(
        `Retrying block hash match in ${delay}ms... (attempt ${attempts}/${maxAttempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      // Fetch both hashes in parallel for better performance
      const [originalHash, syncingHash] = await Promise.all([
        getBlockHash(originalProvider_v9, blockNumber),
        getBlockHash(syncingProvider_v9, blockNumber),
      ]);
      logger.info(`Original node block hash: ${originalHash}`);
      logger.info(`Syncing node block hash: ${syncingHash}`);

      // Check if we failed to fetch either hash
      if (!originalHash || !syncingHash) {
        const errorMsg = `Failed to fetch block hash for block ${blockNumber} (original: ${originalHash}, syncing: ${syncingHash})`;
        logger.warn(errorMsg);
        // This is retriable - block might not be finalized yet
        continue;
      }

      // Both hashes retrieved - check if they match
      if (originalHash !== syncingHash) {
        // Hash mismatch is NOT retriable - fail immediately
        recordBlockStatus("hash_mismatch");
        incrementErrors("block_hash_mismatch", "matchBlockHash");
        throw new BlockHashMismatchError(
          blockNumber,
          originalHash,
          syncingHash
        );
      }

      recordBlockProcessingDuration("verify_hash", endTimer());
      return;
    } catch (error) {
      // If it's a hash mismatch error, don't retry
      if (error instanceof BlockHashMismatchError) {
        logger.error(
          `❌ Block hash mismatch detected at block ${blockNumber} - failing without retry`
        );
        throw error;
      }

      // For other errors, check if we've exhausted retries
      if (attempts >= maxAttempts) {
        logger.error(
          `❌ All ${maxAttempts} attempts failed for block ${blockNumber}`
        );
        incrementErrors("block_hash_match_failed", "matchBlockHash");
        throw error;
      }

      // Otherwise, log and continue to next attempt
      logger.warn(
        `Attempt ${attempts}/${maxAttempts} failed for block ${blockNumber}: ${error}`
      );
    }
  }

  incrementErrors("block_hash_match_timeout", "matchBlockHash");
  throw new Error(
    `Failed to match block hash for block ${blockNumber} after ${maxAttempts} attempts`
  );
}
