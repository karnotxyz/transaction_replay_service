import axios, { AxiosResponse } from "axios";
import { RpcProvider } from "starknet";

import * as starknet from "starknet";
import { getBalance, getNonce } from "./utils.js";

interface Provider {
  nodeUrl: string;
  getClassByHash: (hash: string) => Promise<any>;
}

interface Transaction {
  class_hash?: string;
  sender_address?: string;
  max_fee: string;
  signature: string[];
  nonce: string;
  version: string;
  compiled_class_hash?: string;
  contract_address_salt?: string;
  constructor_calldata?: string[];
  contract_address?: string;
  entry_point_selector?: string;
  calldata?: string[];
}

async function declare(
  tx: Transaction,
  originalProvider: RpcProvider,
  syncingProvider: RpcProvider,
): Promise<string> {
  let contract_class = await originalProvider.getClassByHash(tx.class_hash!);
  let result: AxiosResponse<any>;

  if (tx.sender_address === "0x1") {
    result = await postWithRetry(process.env.RPC_URL_SYNCING_NODE!, {
      id: 0,
      jsonrpc: "2.0",
      method: "starknet_addDeclareTransaction",
      params: {
        declare_transaction: {
          type: "DECLARE",
          contract_class,
          version: "0x1",
          max_fee: tx.max_fee,
          signature: ["0x1", "0x1"],
          sender_address: "0x1",
          nonce: await getNonce("0x1", syncingProvider, tx.nonce),
        },
      },
    });
  } else {
    // TODO : fix this
    // if (tx.version === "0x2") {
    //   const contract_class_parsed = starknet.provider.parseContract(
    //     contract_class,
    //   );
    //   contract_class = {
    //     ...contract_class_parsed,
    //     sierra_program: contract_class.sierra_program,
    //   };
    // }
    result = await postWithRetry(process.env.RPC_URL_SYNCING_NODE!, {
      id: 0,
      jsonrpc: "2.0",
      method: "starknet_addDeclareTransaction",
      params: {
        declare_transaction: {
          type: "DECLARE",
          contract_class,
          version: tx.version,
          max_fee: tx.max_fee,
          signature: tx.signature,
          sender_address: tx.sender_address,
          nonce: await getNonce(tx.sender_address!, syncingProvider, tx.nonce),
          compiled_class_hash: tx.compiled_class_hash,
        },
      },
    });
  }
  return result.data.result.transaction_hash;
}

async function deploy_account(tx: Transaction, syncingProvider: RpcProvider) {
  if (tx.max_fee !== "0x0") {
    while (true) {
      const contract_address =
        await starknet.hash.calculateContractAddressFromHash(
          tx.contract_address_salt!,
          tx.class_hash!,
          tx.constructor_calldata!,
          "0x0",
        );
      const balance = await getBalance(contract_address, syncingProvider);
      if (balance > 0n) break;

      console.log("Can't deploy without funds, waiting for 6 seconds");
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
  }

  const result = await postWithRetry( process.env.RPC_URL_SYNCING_NODE!, {
    id: 0,
    jsonrpc: "2.0",
    method: "starknet_addDeployAccountTransaction",
    params: {
      deploy_account_transaction: {
        type: "DEPLOY_ACCOUNT",
        max_fee: tx.max_fee,
        signature: tx.signature,
        nonce: "0x0",
        contract_address_salt: tx.contract_address_salt,
        constructor_calldata: tx.constructor_calldata,
        class_hash: tx.class_hash,
        version: tx.version,
      },
    },
  });

  const txn_hash = result.data.result.transaction_hash;

  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.SYNCING_NODE_BLOCK_TIME) * 1000),
  );
  return txn_hash;
}

async function invoke(tx: Transaction, syncingProvider: RpcProvider) {
  const result = await postWithRetry(process.env.RPC_URL_SYNCING_NODE!, {
    id: 0,
    jsonrpc: "2.0",
    method: "starknet_addInvokeTransaction",
    params: {
      invoke_transaction: {
        type: "INVOKE",
        sender_address: tx.sender_address,
        calldata: tx.calldata,
        max_fee: tx.max_fee,
        signature: tx.signature,
        nonce: await getNonce(tx.sender_address!, syncingProvider, tx.nonce),
        version: tx.version,
      },
    },
  });
  return result.data.result.transaction_hash;
}

// TODO: handle by sending the actual transaction on L1
async function l1_handler(tx: Transaction, syncingProvider: RpcProvider) {
  const result = await postWithRetry(process.env.RPC_URL_SYNCING_NODE!, {
    id: 0,
    jsonrpc: "2.0",
    method: "starknet_consumeL1Message",
    params: {
      l1_handler_transaction: {
        nonce: tx.nonce,
        contract_address: tx.contract_address,
        entry_point_selector: tx.entry_point_selector,
        calldata: tx.calldata,
        version: tx.version,
      },
      fee: "0xfffffff",
    },
  });
  console.log(result.data);
  return "L1_HANDLER";
}

async function postWithRetry(
  url: string,
  data: Record<string, any>,
): Promise<AxiosResponse<any>> {
  const MAX_ATTEMPTS = 3;
  const SLEEP = 30000;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const result = await axios.post(url, data);
    if (result.data.error && result.data.error.code === 55) {
      console.log("Account validation failed, retrying in 30 seconds");
      await new Promise((resolve) => setTimeout(resolve, SLEEP));
    } else {
      return result;
    }
  }
  throw new Error("Max retries exceeded for transaction");
}

export { declare, deploy_account, invoke, l1_handler };
