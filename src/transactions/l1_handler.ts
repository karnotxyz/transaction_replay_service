import * as starknet from "starknet";
import { postWithRetry } from "../utils.js";
import { config } from "../config.js";
import { L1HandlerConfig } from "../constants.js";
import logger from "../logger.js";

export async function l1_handler_message(tx: starknet.TransactionWithHash) {
  type L1_HANDLER_TXN = {
    version: string;
    nonce: string;
    contract_address: string;
    entry_point_selector: string;
    calldata: string[];
  };

  type L1_HANDLER_TXN_SEND = {
    version: string;
    nonce: number;
    contract_address: string;
    entry_point_selector: string;
    calldata: string[];
  };

  type L1_HANDLER_MESSAGE = {
    tx: L1_HANDLER_TXN_SEND;
    paid_fee_on_l1: number;
  };

  // Extract the transaction data and convert to the required format
  let txn = tx as unknown as L1_HANDLER_TXN;

  const l1HandlerMessage: L1_HANDLER_MESSAGE = {
    tx: {
      version: txn.version,
      nonce: parseInt(txn.nonce, 16),
      contract_address: txn.contract_address,
      entry_point_selector: txn.entry_point_selector,
      calldata: txn.calldata,
    },
    paid_fee_on_l1: L1HandlerConfig.DEFAULT_PAID_FEE,
  };

  const result = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_addL1HandlerMessage",
    params: [l1HandlerMessage],
  });

  // Check if the status is successful
  if (result.status === 200) {
    logger.debug(
      `L1 Handler Message sent successfully: ${result.data.result.transaction_hash}`,
    );
  } else {
    logger.error("Failed to send L1 Handler Message");
  }

  return result.data.result.transaction_hash;
}
