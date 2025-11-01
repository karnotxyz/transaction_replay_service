import { RpcProvider } from "starknet";

import * as starknet from "starknet";
import { TransactionWithHash, TransactionType } from "starknet";
import { generalInvoke } from "./invoke.js";
import { generalDeclare } from "./declare.js";
import { generalDeployAccount } from "./deploy_account.js";
import { l1_handler_message } from "./l1_handler.js";
import { originalProvider_v9, syncingProvider_v9 } from "../providers.js";
import { MadaraDownError, isMadaraDownError } from "../utils.js";

export async function processTx(
  tx: TransactionWithHash,
  block_no: number,
): Promise<string> {
  try {
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

    return tx.transaction_hash;
  } catch (error) {
    // Check if this is a Madara down error and propagate it
    if (error instanceof MadaraDownError || isMadaraDownError(error)) {
      throw new MadaraDownError(
        `Madara down while processing transaction ${tx.transaction_hash}: ${error}`,
      );
    }
    throw error;
  }
}
