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

  if (nonce_tracker[address] === undefined) {
    nonce_tracker[address] = Number(await provider.getNonceForAddress(address));
  }

  const address_nonce = nonce_tracker[address];
  nonce_tracker[address] += 1;

  return `0x${address_nonce.toString(16)}`;
}

// export async function setDisableFee(value: boolean): Promise<void> {
//   logger.info(`Setting disable fees to - ${value}`);
//   const api = await ApiPromise.create({ provider: polkadotProvider });
//   const extrinsic = api.tx.starknet.setDisableFee(value);
//   await extrinsic.send();

//   // Sleep for 7 seconds
//   await new Promise((resolve) => setTimeout(resolve, 7000));
// }

/**
 * Create or update syncing_db row.
 */
// export async function syncDbCreateOrUpdate(
//   attribute: string,
//   // FIX: The 'value' parameter is changed from 'string' to 'number' to match
//   // the model definition (DataTypes.INTEGER) and how it's being called.
//   value: number
// ): Promise<void> {
//   // FIX: Use the initialized model from the db object.
//   const row = await db.syncing_db.findOne({ where: { attribute } });

//   if (row != null) {
//     row.dataValues.value = value;
//     await row.save();
//     return;
//   }

//   // FIX: Use the initialized model from the db object.
//   await db.syncing_db.create({ attribute, value });
// }

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
  const transactionReceipt =
    await provider.getTransactionReceipt(transaction_hash);
  return transactionReceipt;
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
    logger.info("Error closing block:", error);
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
    const result = await axios.post(url, data);
    if (result.data.error && result.data.error.code === 55) {
      console.log(`Account validation failed, retrying in 30 seconds, result:`);
      console.log(result.data);
      await new Promise((resolve) => setTimeout(resolve, SLEEP));
    } else {
      return result;
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

  while (retryCount <= maxRetries) {
    try {
      logger.debug(
        `Getting receipt for transaction - ${tx_hash} (attempt ${retryCount + 1}/${maxRetries + 1})`,
      );

      const transactionReceipt = await getTransactionReceipt(provider, tx_hash);

      // console.log('Getting receipt for transaction', transactionReceipt.statusReceipt);
      // Validate if the transaction was a success or not !
      if (!transactionReceipt.isSuccess() && !transactionReceipt.isReverted()) {
        throw new Error(`Transaction in unexpected state ${tx_hash}`);
      }

      // Validate that the transaction was successful and in the correct block
      // if (txn_receipt.block_number !== expectedBlockNumber) {
      //   throw new Error(
      //     `Transaction ${tx_hash} receipt block number ${txn_receipt.block_number} does not match expected block ${expectedBlockNumber}`
      //   );
      // }

      // console.log(`Successfully validated receipt for transaction - ${tx_hash}`);

      // Success - exit the retry loop
      return;
    } catch (error) {
      retryCount++;
      // console.warn(`Receipt validation attempt ${retryCount} failed for transaction ${tx_hash}:`);

      if (retryCount > maxRetries) {
        const errorMsg = `Failed to validate receipt for transaction ${tx_hash} after ${maxRetries} attempts. Latest error: ${error}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      // Calculate delay based on strategy
      const delay = useExponentialBackoff
        ? Math.pow(2, retryCount) * 1000 // Exponential backoff: 2s, 4s, 8s, 16s, 32s, etc.
        : fixedDelay; // Fixed delay

      // console.log(`Retrying receipt validation for transaction ${tx_hash} in ${delay}ms...`);
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

      if (!paradexBlock || !madaraBlock) {
        const errorMsg = `Failed to fetch block hash for block number ${block_number}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      // check if block hashes match
      if (paradexBlock !== madaraBlock) {
        const errorMsg = `Block hashes do not match for block number ${block_number}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
        return;
      }

      // Success - exit the retry loop
      return;
    } catch (error) {
      logger.warn(
        `Attempt ${attempt}/${maxAttempts} failed for block ${block_number}:`,
      );

      // If this was the last attempt, throw the error
      if (attempt === maxAttempts) {
        logger.error(
          `All ${maxAttempts} attempts failed for block ${block_number}`,
        );
        throw error;
      }
    }
  }
}
