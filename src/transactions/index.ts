import { RpcProvider } from "starknet";

import * as starknet from "starknet";
import { TransactionWithHash, TransactionType } from "starknet";
import { generalInvoke } from "./invoke.js";
import { generalDeclare } from "./declare.js";
import { generalDeployAccount } from "./deploy_account.js";
import { l1_handler_message } from "./l1_handler.js";
import { originalProvider_v9, syncingProvider_v9 } from "../providers.js";

export async function processTx(
  tx: TransactionWithHash,
  block_no: number,
): Promise<string> {
  // TODO: maybe do this later
  // if (tx === "0x0" && !feesDisabled) {
  //   await setDisableFee(true);
  //   feesDisabled = true;
  // } else if (tx.max_fee !== "0x0" && feesDisabled) {
  //   await setDisableFee(false);
  //   feesDisabled = false;
  // }

  const handlers: Record<string, () => Promise<string>> = {
    INVOKE: () => generalInvoke(tx, syncingProvider_v9),
    DEPLOY_ACCOUNT: () => generalDeployAccount(tx, syncingProvider_v9),
    DECLARE: () => generalDeclare(tx, syncingProvider_v9),
    L1_HANDLER: () => l1_handler_message(tx, syncingProvider_v9),
  };

  const handler = handlers[tx.type];
  if (handler) {
    return await handler();
  }

  // case "DEPLOY": {
  //   let tx_hash = await declare(tx, originalProvider_v9, syncingProvider_v9);
  //   return tx_hash;
  // }

  return tx.transaction_hash;
}
