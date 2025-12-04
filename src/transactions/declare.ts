import * as starknet from "starknet";
import { postWithRetry, getNonce } from "../utils.js";
import { config } from "../config.js";

/**
 * General declare transaction handler
 */
export async function generalDeclare(
  tx: starknet.TransactionWithHash,
  syncingProvider: starknet.RpcProvider,
) {
  let tx_version = tx.version;

  switch (tx_version) {
    case "0x0": {
      return declareV0(tx, syncingProvider);
    }

    case "0x1": {
      return declareV1(tx, syncingProvider);
    }

    case "0x2": {
      return declareV2(tx, syncingProvider);
    }

    case "0x3": {
      return declareV3(tx, syncingProvider);
    }
    default: {
      throw new Error(`Unsupported Declare transaction version: ${tx_version}`);
    }
  }
}

async function declareV0(
  tx: starknet.TransactionWithHash,
  syncingProvider: starknet.RpcProvider,
) {
  type DECLARE_TXN_V0 = {
    type: "DECLARE";
    sender_address: string;
    max_fee: starknet.FELT;
    version: "0x0";
    signature: starknet.Signature;
    class_hash: starknet.FELT;
  };

  let txn = tx as unknown as DECLARE_TXN_V0;

  const result = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_bypassAddDeclareTransaction",
    params: [
      {
        type: "DECLARE",
        sender_address: txn.sender_address,
        max_fee: txn.max_fee,
        version: txn.version,
        signature: txn.signature,
        class_hash: txn.class_hash,
      },
    ],
  });

  return result.data.result.transaction_hash;
}

async function declareV1(
  tx: starknet.TransactionWithHash,
  syncingProvider: starknet.RpcProvider,
) {
  type DECLARE_TXN_V1 = {
    type: "DECLARE";
    sender_address: string;
    max_fee: starknet.FELT;
    version: "0x1";
    signature: starknet.Signature;
    nonce: starknet.FELT;
    class_hash: starknet.FELT;
  };

  let txn = tx as unknown as DECLARE_TXN_V1;

  const result = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_bypassAddDeclareTransaction",
    params: [
      {
        type: "DECLARE",
        sender_address: txn.sender_address,
        max_fee: txn.max_fee,
        version: txn.version,
        signature: txn.signature,
        nonce: await getNonce(txn.sender_address!, syncingProvider, txn.nonce),
        class_hash: txn.class_hash,
      },
    ],
  });

  return result.data.result.transaction_hash;
}

async function declareV2(
  tx: starknet.TransactionWithHash,
  syncingProvider: starknet.RpcProvider,
) {
  type DECLARE_TXN_V2 = {
    type: "DECLARE";
    sender_address: string;
    compiled_class_hash: starknet.FELT;
    max_fee: starknet.FELT;
    version: "0x2";
    signature: starknet.Signature;
    nonce: starknet.FELT;
    class_hash: starknet.FELT;
  };

  let txn = tx as unknown as DECLARE_TXN_V2;

  const result = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_bypassAddDeclareTransaction",
    params: [
      {
        type: "DECLARE",
        sender_address: txn.sender_address,
        compiled_class_hash: txn.compiled_class_hash,
        max_fee: txn.max_fee,
        version: txn.version,
        signature: txn.signature,
        nonce: await getNonce(txn.sender_address!, syncingProvider, txn.nonce),
        class_hash: txn.class_hash,
      },
    ],
  });

  return result.data.result.transaction_hash;
}

async function declareV3(
  tx: starknet.TransactionWithHash,
  syncingProvider: starknet.RpcProvider,
) {
  type DECLARE_TXN_V3 = {
    type: "DECLARE";
    sender_address: string;
    compiled_class_hash: starknet.FELT;
    version: "0x3";
    signature: starknet.Signature;
    nonce: starknet.FELT;
    class_hash: starknet.FELT;
    resource_bounds: starknet.ResourceBounds;
    tip: string; // u64 is internally string in js
    paymaster_data: starknet.FELT[];
    account_deployment_data: starknet.FELT[];
    nonce_data_availability_mode: starknet.EDataAvailabilityMode;
    fee_data_availability_mode: starknet.EDataAvailabilityMode;
  };

  let txn = tx as unknown as DECLARE_TXN_V3;

  const result = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_bypassAddDeclareTransaction",
    params: [
      {
        type: "DECLARE",
        sender_address: txn.sender_address,
        compiled_class_hash: txn.compiled_class_hash,
        version: txn.version,
        signature: txn.signature,
        nonce: await getNonce(txn.sender_address!, syncingProvider, txn.nonce),
        class_hash: txn.class_hash,
        resource_bounds: txn.resource_bounds,
        tip: txn.tip,
        paymaster_data: txn.paymaster_data,
        account_deployment_data: txn.account_deployment_data,
        nonce_data_availability_mode: txn.nonce_data_availability_mode,
        fee_data_availability_mode: txn.fee_data_availability_mode,
      },
    ],
  });

  console.log("result: ", result);
  return result.data.result.transaction_hash;
}
