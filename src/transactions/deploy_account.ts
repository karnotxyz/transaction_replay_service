import * as starknet from "starknet";
import { postWithRetry, getNonce } from "../utils.js";

// https://www.quicknode.com/docs/starknet/starknet_addDeployAccountTransaction
export async function generalDeployAccount(
  tx: starknet.TransactionWithHash,
  syncingProvider: starknet.RpcProvider,
) {
  let tx_version = tx.version;

  switch (tx_version) {
    case "0x1": {
      return deployAccountV1(tx, syncingProvider);
    }

    case "0x3": {
      return deployAccountV3(tx, syncingProvider);
    }
    default: {
      throw new Error(
        `Unsupported Deploy Account transaction version: ${tx_version}`,
      );
    }
  }
}

async function deployAccountV1(
  tx: starknet.TransactionWithHash,
  syncingProvider: starknet.RpcProvider,
) {
  type DEPLOY_ACCOUNT_TXN_V1 = {
    type: "DEPLOY_ACCOUNT";
    max_fee: starknet.FELT;
    version: "0x1";
    signature: starknet.Signature;
    nonce: starknet.FELT;
    contract_address_salt: starknet.FELT;
    constructor_calldata: starknet.FELT[];
    class_hash: starknet.FELT;
  };
  let txn = tx as unknown as DEPLOY_ACCOUNT_TXN_V1;

  const result = await postWithRetry(process.env.RPC_URL_SYNCING_NODE!, {
    id: 1,
    jsonrpc: "2.0",
    method: "starknet_addDeployAccountTransaction",
    params: [
      {
        type: "DEPLOY_ACCOUNT",
        max_fee: txn.max_fee,
        version: txn.version,
        signature: txn.signature,
        nonce: txn.nonce,
        contract_address_salt: txn.contract_address_salt,
        constructor_calldata: txn.constructor_calldata,
        class_hash: txn.class_hash,
      },
    ],
  });

  return result.data.result.transaction_hash;
}

async function deployAccountV3(
  tx: starknet.TransactionWithHash,
  syncingProvider: starknet.RpcProvider,
) {
  type DEPLOY_ACCOUNT_TXN_V3 = {
    type: "DEPLOY_ACCOUNT";
    version: "0x3";
    signature: starknet.Signature;
    nonce: starknet.FELT;
    contract_address_salt: starknet.FELT;
    constructor_calldata: starknet.FELT[];
    class_hash: starknet.FELT;
    resource_bounds: starknet.ResourceBounds;
    tip: starknet.FELT;
    paymaster_data: starknet.FELT[];
    nonce_data_availability_mode: starknet.EDataAvailabilityMode;
    fee_data_availability_mode: starknet.EDataAvailabilityMode;
  };

  let txn = tx as unknown as DEPLOY_ACCOUNT_TXN_V3;

  const result = await postWithRetry(process.env.RPC_URL_SYNCING_NODE!, {
    id: 1,
    jsonrpc: "2.0",
    method: "starknet_addDeployAccountTransaction",
    params: [
      {
        type: "DEPLOY_ACCOUNT",
        version: txn.version,
        signature: txn.signature,
        nonce: txn.nonce,
        contract_address_salt: txn.contract_address_salt,
        constructor_calldata: txn.constructor_calldata,
        class_hash: txn.class_hash,
        resource_bounds: txn.resource_bounds,
        tip: txn.tip,
        paymaster_data: txn.paymaster_data,
        nonce_data_availability_mode: txn.nonce_data_availability_mode,
        fee_data_availability_mode: txn.fee_data_availability_mode,
      },
    ],
  });

  return result.data.result.transaction_hash;
}
