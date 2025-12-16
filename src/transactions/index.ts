import { TransactionWithHash } from "starknet";
import { generalInvoke } from "./invoke.js";
import { generalDeclare } from "./declare.js";
import { generalDeployAccount } from "./deploy_account.js";
import { l1_handler_message } from "./l1_handler.js";
import { syncingProvider_v9 } from "../providers.js";
import { MadaraDownError, isMadaraDownError } from "../errors/index.js";
import {
  incrementTransactionsProcessed,
  recordTransactionProcessingDuration,
  recordTransactionStatus,
  startTimer,
  incrementErrors,
} from "../telemetry/metrics.js";

export async function processTx(
  tx: TransactionWithHash,
  block_no: number,
): Promise<string> {
  const endTimer = startTimer();
  const txType = tx.type;
  const txVersion = (tx as any).version || "unknown";

  try {
    const handlers: Record<string, () => Promise<string>> = {
      INVOKE: () => generalInvoke(tx, syncingProvider_v9),
      DEPLOY_ACCOUNT: () => generalDeployAccount(tx, syncingProvider_v9),
      DECLARE: () => generalDeclare(tx, syncingProvider_v9),
      L1_HANDLER: () => l1_handler_message(tx, syncingProvider_v9),
    };

    const handler = handlers[tx.type];
    if (handler) {
      const result = await handler();

      // Record successful transaction processing
      incrementTransactionsProcessed(txType, txVersion);
      recordTransactionStatus(txType, txVersion, "success");
      recordTransactionProcessingDuration(txType, txVersion, endTimer());

      return result;
    }

    // Record successful transaction processing for unknown type
    incrementTransactionsProcessed(txType, txVersion);
    recordTransactionStatus(txType, txVersion, "success");
    recordTransactionProcessingDuration(txType, txVersion, endTimer());

    return tx.transaction_hash;
  } catch (error) {
    // Record failed transaction
    recordTransactionStatus(txType, txVersion, "failed");
    incrementErrors("transaction_processing_error", `processTx_${txType}`);

    // Check if this is a Madara down error and propagate it
    if (error instanceof MadaraDownError || isMadaraDownError(error)) {
      throw new MadaraDownError(
        `Madara down while processing transaction ${tx.transaction_hash}: ${error}`,
      );
    }
    throw error;
  }
}
