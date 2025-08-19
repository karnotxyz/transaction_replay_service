
import { Model } from "sequelize";
// FIX: Import the central 'db' object instead of the model factory function directly.
// The 'db' object contains all fully initialized Sequelize models.
import db from "./models/index.js";
import { LAST_SYNCED_BLOCK_KEY, LAST_SYNCED_TXN_INDEX } from "./constants.js";
import logger from "./logger.js";
import {
  processTx
} from "./transactions/index.js";
import {
  syncDbCreateOrUpdate,
  getLatestBlockNumber,
} from "./utils.js";
import { sendAlert } from "./sns.js";
import { originalProvider, syncingProvider } from "./providers.js";
import { verifyEvents } from "./verify_events.js";
import { BlockIdentifier, TransactionWithHash, TXN_HASH } from "starknet";

let feesDisabled = false;

// FIX: This type definition is corrected.
// We define an interface for the model's attributes and an instance type
// that combines Sequelize's Model class with our attributes for type safety.
interface SyncingDbAttributes {
  id: number;
  attribute: string;
  value: number;
}
interface SyncingDbInstance extends Model<SyncingDbAttributes>, SyncingDbAttributes {}


export async function syncBlocks(syncTo?: number): Promise<void> {
  try {
    // await setDisableFee(false);
  } catch (err) {
    logger.error(`Error setting disable fee to false, error - ${err}`);
    console.error(err);
    await sendAlert(
      "[SYNCING_SERVICE] Error setting disable fee to false",
      `Error setting disable fee to false, error - ${err}`,
    );
    return;
  }

  feesDisabled = false;

  // FIX: We now call 'findOne' on the correctly initialized model (db.syncing_db)
  // and cast the result to our new interface for type-safe access to 'value'.
  let lastSyncedBlockRecord = (await db.syncing_db.findOne({
    where: { attribute: LAST_SYNCED_BLOCK_KEY },
  })) as SyncingDbInstance | null;

  let lastSyncedBlock = lastSyncedBlockRecord ? lastSyncedBlockRecord.value : -1;

  let skipTransactionsRecord = (await db.syncing_db.findOne({
    where: { attribute: LAST_SYNCED_TXN_INDEX },
  })) as SyncingDbInstance | null;

  let skipTransactions = skipTransactionsRecord ? skipTransactionsRecord.value : -1;

  let latestBlock = await getLatestBlockNumber(originalProvider);
  if (syncTo) {
    latestBlock = syncTo;
  }

  logger.info(`Last synced block - ${lastSyncedBlock}`);
  logger.info(`Latest block - ${latestBlock}`);

  for (let i = lastSyncedBlock + 1; i <= latestBlock; i++) {
    logger.info(`Syncing block - ${i}`);
    try {
      await syncBlock(i, skipTransactions + 1);
      skipTransactions = -1;
    } catch (e) {
      logger.error(`Error syncing block - ${i}, error - ${e}`);
      console.error(e);
      await sendAlert(
        "[SYNCING_SERVICE] Error syncing block",
        `Error syncing block - ${i}, error - ${e}`,
      );
      return;
    }

    try {
      // FIX: These calls now correctly pass a number, matching the updated
      // function signature in utils.ts. The TypeScript error is gone.
      await syncDbCreateOrUpdate(LAST_SYNCED_BLOCK_KEY, i);
      await syncDbCreateOrUpdate(LAST_SYNCED_TXN_INDEX, -1);
    } catch (e) {
      logger.error(
        `Error updating last synced block in DB, block - ${i}, error - ${e}`,
      );
      console.error(e);
      await sendAlert(
        "[SYNCING_SERVICE] Error updating last synced block in DB",
        `Error updating last synced block in DB, block - ${i}, error - ${e}`,
      );
      throw e;
    }
  }

  await verifyEvents();
}


async function syncBlock(block_no: number, skip_transactions: number): Promise<void> {
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


  for (let i = skip_transactions; i < blockWithTxs.transactions.length; i++) {
    const tx : TransactionWithHash = blockWithTxs.transactions[i];

    console.log(`Processing transaction - ${tx.transaction_hash}`);
    let tx_hash: string;

    try {
      tx_hash = await processTx(tx, block_no);
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

    if (tx_hash !== tx.transaction_hash && tx.type !== "L1_HANDLER") {
      await sendAlert(
        "[SYNCING_SERVICE] Transaction hash mismatch",
        `Transaction hash mismatch, original - ${tx.transaction_hash}, synced - ${tx_hash}`,
      );
      logger.warn(
        `Transaction hash mismatch, original - ${tx.transaction_hash}, synced - ${tx_hash}`,
      );
    }

    try {
      // FIX: This call now correctly passes a number.
      await syncDbCreateOrUpdate(LAST_SYNCED_TXN_INDEX, i);
    } catch (e) {
      logger.error(
        `Error updating last synced transaction index in DB, transaction - ${tx.transaction_hash}, error - ${e}`,
      );
      console.error(e);
      throw new Error("Error updating last synced transaction index in DB");
    }

    logger.info(`Completed transaction - ${i}`);
  }
}
