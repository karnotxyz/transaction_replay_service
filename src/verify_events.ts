// import { ProviderInterface, Contract, GetTransactionReceiptResponse, RpcProvider, SuccessfulTransactionReceiptResponse } from "starknet";
// import { originalProvider, syncingProvider } from "./providers.js";
// import { sendAlert } from "./sns.js";
// import db from "./models/index.js";
// import {
//   LAST_VERIFIED_BLOCK_KEY,
//   LAST_SYNCED_BLOCK_KEY,
// } from "./constants.js";
// import logger from "./logger.js";
// // import { syncDbCreateOrUpdate } from "./utils.js";
// // import syncing_db from "./models/syncing_db.js"; // adjust if your models export differently

// // --- Helper functions ---

// async function getEvents(
//   txn_hash: string,
//   provider: RpcProvider
// ): Promise<any> {
//   const receipt = await provider.getTransactionReceipt(txn_hash);
//   let x =  receipt.value as SuccessfulTransactionReceiptResponse;
//   return x.events;
// }

// function filterNonMatchableEvents(
//   events: any[],
//   sequencerAddress: string
// ): any[] {
//   return events.filter(
//     (event) =>
//       !(
//         event.from_address ===
//           "0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7" &&
//         event.keys[0] ===
//           "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9" &&
//         event.data[1] === sequencerAddress
//       )
//   );
// }

// function matchEvents(originalEvents: any[], syncingEvents: any[]): boolean {
//   const originalMatchable = filterNonMatchableEvents(
//     originalEvents,
//     "0x46a89ae102987331d369645031b49c27738ed096f2789c24449966da4c6de6b"
//   );
//   const syncingMatchable = filterNonMatchableEvents(syncingEvents, "0xdead");

//   if (originalMatchable.length !== syncingMatchable.length) {
//     return false;
//   }

//   logger.info(
//     `Actual events count, original - ${originalEvents.length}, syncing - ${syncingEvents.length}`
//   );
//   logger.info(
//     `Matching events count, original - ${originalMatchable.length}, syncing - ${syncingMatchable.length}`
//   );

//   return JSON.stringify(originalMatchable) === JSON.stringify(syncingMatchable);
// }

// async function matchTransactions(
//   txn_hash: string,
//   originalProvider: RpcProvider,
//   syncingProvider: RpcProvider
// ): Promise<boolean> {
//   try {
//     const originalTx = await originalProvider.getTransaction(txn_hash);

//     // if (Number(originalTx) === 0) {
//     //   logger.info(`ℹ️ Skipping txn with zero fees: ${txn_hash}`);
//     //   return true;
//     // }

//     const [originalEvents, syncingEvents] = await Promise.all([
//       getEvents(txn_hash, originalProvider),
//       getEvents(txn_hash, syncingProvider),
//     ]);

//     return matchEvents(originalEvents, syncingEvents);
//   } catch (err) {
//     logger.error("❌ Error matching events: ", err);
//     sendAlert(
//       "[SYNCING_SERVICE] Error matching events",
//       `Error matching events: ${err}`
//     );
//     return false;
//   }
// }

// async function matchBlock(
//   block_no: number,
//   originalProvider: RpcProvider,
//   syncingProvider: RpcProvider
// ): Promise<void> {
//   const block = await originalProvider.getBlockWithTxs(block_no);
//   const promises: Promise<boolean>[] = [];

//   for (const tx of block.transactions) {
//     if (tx.type === "L1_HANDLER") {
//       logger.info(`ℹ️ Skipping L1_HANDLER txn: ${tx.transaction_hash}`);
//       continue;
//     }

//     logger.info(`Processing txn: ${tx.transaction_hash}, ...`);
//     promises.push(
//       matchTransactions(tx.transaction_hash, originalProvider, syncingProvider)
//     );
//   }

//   const matchResults = await Promise.all(promises);

//   for (let i = 0; i < matchResults.length; i++) {
//     if (!matchResults[i]) {
//       const badTxn = block.transactions[i].transaction_hash;
//       logger.error(`❌ Events do not match for txn: ${badTxn}`);
//       sendAlert(
//         "[SYNCING_SERVICE] Events do not match",
//         `Events do not match for txn - ${badTxn}`
//       );
//       throw new Error(`❌ Events do not match for txn: ${badTxn}`);
//     } else {
//       logger.info(`✅ Events match for txn: ${block.transactions[i].transaction_hash}`);
//     }
//   }
// }

// // --- Main verifier ---

// export async function verifyEvents(): Promise<void> {
//   logger.info("Verifying events...");

//   let lastVerifiedBlock: number;
//   const lastVerifiedRow = await db.syncing_db.findOne({
//     where: { attribute: LAST_VERIFIED_BLOCK_KEY },
//   });

//   if (lastVerifiedRow === null) {
//     lastVerifiedBlock = Number(process.env.SKIP_VERIFCATION_BLOCKS ?? 0);
//   } else {
//     lastVerifiedBlock = Number(lastVerifiedRow.dataValues.value);
//   }

//   const lastSyncedRow = await db.syncing_db.findOne({
//     where: { attribute: LAST_SYNCED_BLOCK_KEY },
//   });

//   if (lastSyncedRow === null) {
//     logger.info("No blocks to verify - syncing not started yet");
//     return;
//   }

//   const latestBlock: number = Number(lastSyncedRow.dataValues.value);

//   logger.info(`Last verified block: ${lastVerifiedBlock}`);
//   logger.info(`Latest block: ${latestBlock}`);

//   for (let block_no = lastVerifiedBlock + 1; block_no <= latestBlock; block_no++) {
//     try {
//       logger.info(`Verifying block: ${block_no} ...`);
//       await matchBlock(block_no, originalProvider, syncingProvider);
//       await syncDbCreateOrUpdate(LAST_VERIFIED_BLOCK_KEY, block_no);
//     } catch (err) {
//       logger.error(`❌ Error verifying block: ${block_no}, error: ${err}`);
//       console.error(err);
//       return;
//     }
//   }
// }
