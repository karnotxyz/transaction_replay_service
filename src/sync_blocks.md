
import { Model } from "sequelize";
// FIX: Import the central 'db' object instead of the model factory function directly.
// The 'db' object contains all fully initialized Sequelize models.
// import db from "./models/index.js";
import { LAST_SYNCED_BLOCK_KEY, LAST_SYNCED_TXN_INDEX } from "./constants.js";
import logger from "./logger.js";
import {
  processTx
} from "./transactions/index.js";
import {
  // syncDbCreateOrUpdate,
  getLatestBlockNumber,
  closeBlock,
  validateTransactionReceipt,
  matchBlockHash
} from "./utils.js";
import { sendAlert } from "./sns.js";
import { originalProvider, syncingProvider } from "./providers.js";
import { BlockIdentifier, TransactionWithHash, TXN_HASH } from "starknet";

let feesDisabled = false;

// FIX: This type definition is corrected.
// We define an interface for the model's attributes and an instance type
// that combines Sequelize's Model class with our attributes for type safety.
// interface SyncingDbAttributes {
//   id: number;
//   attribute: string;
//   value: number;
// }
// interface SyncingDbInstance extends Model<SyncingDbAttributes>, SyncingDbAttributes {}

export async function syncBlocks(syncFrom: number, syncTo: number): Promise<void> {
  console.log(`Starting sync from block ${syncFrom} to block ${syncTo}`);

  try {
    // Get the latest block number to validate sync range
    const latestBlockNumber = await getLatestBlockNumber(syncingProvider);
    console.log(`Latest block number: ${latestBlockNumber}`);

    // Validate sync range
    if (latestBlockNumber > syncTo) {
      throw new Error(`Sync target ${syncTo} lags behind latest block ${latestBlockNumber}`);
    }

    if (syncFrom > syncTo) {
      throw new Error(`Sync from ${syncFrom} cannot be greater than sync to ${syncTo}`);
    }

    // Loop through each block in the range
    for (let currentBlock = syncFrom; currentBlock <= syncTo; currentBlock++) {
      console.log(`Syncing block ${currentBlock}...`);

      try {

        // Validate the current block
        await validateBlock(currentBlock);

        // Start syncing the next block
        await syncBlock(currentBlock);
        console.log(`Successfully synced block ${currentBlock}`);

        // Close the block after successful sync
        await closeBlock();
        console.log(`Block ${currentBlock} closed successfully`);
        console.log(`Block ${currentBlock} completed successfully`);

        // Validate block
        await matchBlockHash(currentBlock);
        console.log(`Block ${currentBlock} validated successfully`);

      } catch (error) {
        console.error(`Failed to process block ${currentBlock}:`, error);
        throw new Error(`Sync failed at block ${currentBlock}: ${error}`);
      }
    }

    console.log(`Successfully completed sync from block ${syncFrom} to ${syncTo}`);

  } catch (error) {
    console.error('Sync blocks operation failed:', error);
    throw error;
  }
}

// Separate function to handle block validation and syncing
async function validateBlock(currentBlock: number): Promise<void> {
  // Validate that the latest block is only 1 lesser than the current block with retry
  const maxRetries = 5; // Adjust as needed
  let retryCount = 0;
  let blockValidated = false;

  while (retryCount <= maxRetries && !blockValidated) {
    try {
      const latestBlockNumber = await getLatestBlockNumber(syncingProvider);
      console.log(`Latest block number check (attempt ${retryCount + 1}): ${latestBlockNumber}, expecting: ${currentBlock - 1}`);

      if (latestBlockNumber + 1 === currentBlock) {
        blockValidated = true;
        console.log(`Block ${currentBlock} validation successful`);
      } else {
        throw new Error(`Sync block ${currentBlock} is not 1 + ${latestBlockNumber}`);
      }
    } catch (error) {
      retryCount++;
      console.warn(`Block validation attempt ${retryCount} failed for block ${currentBlock}:`, error);

      if (retryCount > maxRetries) {
        throw new Error(`Failed to validate block ${currentBlock} after ${maxRetries + 1} attempts. Latest error: ${error}`);
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s
      const delay = Math.pow(2, retryCount) * 1000;
      console.log(`Retrying block ${currentBlock} validation in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function syncBlock(block_no: number): Promise<void> {
  const blockWithTxs = await originalProvider.getBlockWithTxs(block_no);

  logger.info(
    `Found ${blockWithTxs.transactions.length} transactions to process in block - ${block_no}`,
  );

  if (blockWithTxs.transactions.length === 0) {
    logger.error(
      `No transactions to process in block - ${block_no}. This shouldn't be possible, throwing an error`,
    );
    await sendAlert(
      "[SYNCING_SERVICE] No transactions to process",
      `No transactions to process in block - ${block_no}. This shouldn't be possible`,
    );
    throw new Error("No transactions to process in block");
  }

  // Process all transactions and collect their hashes
  const transactionHashes: string[] = [];

  for (let i = 0; i < blockWithTxs.transactions.length; i++) {
    const tx: TransactionWithHash = blockWithTxs.transactions[i];

    console.log(`Processing transaction - ${tx.transaction_hash}`);
    let tx_hash: string;

    try {
      tx_hash = await processTx(tx, block_no);
      if (i == 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        await validateTransactionReceipt(syncingProvider, tx_hash, {
          useExponentialBackoff: true
        });
      } else {
        await validateTransactionReceipt(syncingProvider, tx_hash);
      }
      // Let's wait for transaction receipt here
      transactionHashes.push(tx_hash);
    } catch (err) {
      logger.error(
        `Error processing transaction - ${tx.transaction_hash}, error - ${err}`,
      );
      console.error(err);
      await sendAlert(
        "[SYNCING_SERVICE] Error processing transaction",
        `Error processing transaction - ${tx.transaction_hash}, error - ${err}`,
      );
      throw err;
    }
  }

  // Wait for all transaction receipts in parallel
  // console.log(`Waiting for receipts of ${transactionHashes.length} transactions...`);

  // // sleep for 1 minute here
  // console.log("Sleeping for 20 secs...");
  // await new Promise(resolve => setTimeout(resolve, 10000));
  // console.log("Finished Sleeping...");

  // try {
  //   const receiptPromises = transactionHashes.map(tx_hash =>
  //     validateTransactionReceipt(syncingProvider, tx_hash)
  //   );

  //   // Wait for all receipts to be validated
  //   await Promise.all(receiptPromises);

  //   console.log(`All ${transactionHashes.length} transaction receipts validated successfully`);
  //   logger.info(`Block ${block_no} - all transaction receipts validated successfully`);

  // } catch (error) {
  //   const errorMsg = `Receipt validation failed for block ${block_no}: ${error}`;
  //   logger.error(errorMsg);
  //   console.error(errorMsg);
  //   await sendAlert(
  //     "[SYNCING_SERVICE] Block receipt validation failed",
  //     errorMsg
  //   );
  //   throw error;
  // }
}
