import { RpcProvider } from "starknet";

import * as starknet from "starknet";
import {TransactionWithHash, TransactionType} from "starknet";
import { getBalance, getNonce } from "../utils.js";
import { generalInvoke } from "./invoke.js";
import { generalDeclare } from "./declare.js";
import { generalDeployAccount } from "./deploy_account.js";
import { l1_handler_message } from "./l1_handler.js";
import { originalProvider, syncingProvider } from "../providers.js";

export async function processTx(tx: TransactionWithHash, block_no: number): Promise<string> {
  // TODO: maybe do this later
  // if (tx === "0x0" && !feesDisabled) {
  //   await setDisableFee(true);
  //   feesDisabled = true;
  // } else if (tx.max_fee !== "0x0" && feesDisabled) {
  //   await setDisableFee(false);
  //   feesDisabled = false;
  // }

  const handlers: Record<string, () => Promise<string>> = {
    INVOKE: () => generalInvoke(tx, syncingProvider),
    DEPLOY_ACCOUNT: () => generalDeployAccount(tx, syncingProvider),
    DECLARE: () => generalDeclare(tx, syncingProvider),
    L1_HANDLER: () => l1_handler_message(tx, syncingProvider),
  };

  const handler = handlers[tx.type];
  if (handler) {
    return await handler();
  }

  // case "DEPLOY": {
  //   let tx_hash = await declare(tx, originalProvider, syncingProvider);
  //   return tx_hash;
  // }

  return tx.transaction_hash;
}
// async function declare(
//   tx: Transaction,
//   originalProvider: RpcProvider,
//   syncingProvider: RpcProvider,
// ): Promise<string> {
//   let contract_class = await originalProvider.getClassByHash(tx.class_hash!);
//   let result: AxiosResponse<any>;

//   if (tx.sender_address === "0x1") {
//     result = await postWithRetry(process.env.RPC_URL_SYNCING_NODE!, {
//       id: 0,
//       jsonrpc: "2.0",
//       method: "starknet_addDeclareTransaction",
//       params: {
//         declare_transaction: {
//           type: "DECLARE",
//           contract_class,
//           version: "0x1",
//           max_fee: tx.max_fee,
//           signature: ["0x1", "0x1"],
//           sender_address: "0x1",
//           nonce: await getNonce("0x1", syncingProvider, tx.nonce),
//         },
//       },
//     });
//   } else {
//     // TODO : fix this
//     // if (tx.version === "0x2") {
//     //   const contract_class_parsed = starknet.provider.parseContract(
//     //     contract_class,
//     //   );
//     //   contract_class = {
//     //     ...contract_class_parsed,
//     //     sierra_program: contract_class.sierra_program,
//     //   };
//     // }
//     result = await postWithRetry(process.env.RPC_URL_SYNCING_NODE!, {
//       id: 0,
//       jsonrpc: "2.0",
//       method: "starknet_addDeclareTransaction",
//       params: {
//         declare_transaction: {
//           type: "DECLARE",
//           contract_class,
//           version: tx.version,
//           max_fee: tx.max_fee,
//           signature: tx.signature,
//           sender_address: tx.sender_address,
//           nonce: await getNonce(tx.sender_address!, syncingProvider, tx.nonce),
//           compiled_class_hash: tx.compiled_class_hash,
//         },
//       },
//     });
//   }
//   return result.data.result.transaction_hash;
// }

// async function deploy_account(tx: Transaction, syncingProvider: RpcProvider) {
//   if (tx.max_fee !== "0x0") {
//     while (true) {
//       const contract_address =
//         await starknet.hash.calculateContractAddressFromHash(
//           tx.contract_address_salt!,
//           tx.class_hash!,
//           tx.constructor_calldata!,
//           "0x0",
//         );
//       const balance = await getBalance(contract_address, syncingProvider);
//       if (balance > 0n) break;

//       console.log("Can't deploy without funds, waiting for 6 seconds");
//       await new Promise((resolve) => setTimeout(resolve, 6000));
//     }
//   }

//   const result = await postWithRetry( process.env.RPC_URL_SYNCING_NODE!, {
//     id: 0,
//     jsonrpc: "2.0",
//     method: "starknet_addDeployAccountTransaction",
//     params: {
//       deploy_account_transaction: {
//         type: "DEPLOY_ACCOUNT",
//         max_fee: tx.max_fee,
//         signature: tx.signature,
//         nonce: "0x0",
//         contract_address_salt: tx.contract_address_salt,
//         constructor_calldata: tx.constructor_calldata,
//         class_hash: tx.class_hash,
//         version: tx.version,
//       },
//     },
//   });

//   const txn_hash = result.data.result.transaction_hash;

//   await new Promise((resolve) =>
//     setTimeout(resolve, Number(process.env.SYNCING_NODE_BLOCK_TIME) * 1000),
//   );
//   return txn_hash;
// }


// // TODO: handle by sending the actual transaction on L1
// async function l1_handler(tx: Transaction, syncingProvider: RpcProvider) {
//   const result = await postWithRetry(process.env.RPC_URL_SYNCING_NODE!, {
//     id: 0,
//     jsonrpc: "2.0",
//     method: "starknet_consumeL1Message",
//     params: {
//       l1_handler_transaction: {
//         nonce: tx.nonce,
//         contract_address: tx.contract_address,
//         entry_point_selector: tx.entry_point_selector,
//         calldata: tx.calldata,
//         version: tx.version,
//       },
//       fee: "0xfffffff",
//     },
//   });
//   console.log(result.data);
//   return "L1_HANDLER";
// }

// export { processTx, declare, deploy_account, invoke, l1_handler };
