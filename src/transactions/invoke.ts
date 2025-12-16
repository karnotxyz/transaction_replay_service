import * as starknet from "starknet";
import { postWithRetry } from "../utils.js";
import { config } from "../config.js";

/**
 * General invoke transaction handler - routes to version-specific handlers
 */
export async function generalInvoke(
  tx: starknet.TransactionWithHash,
) {
  let tx_version = tx.version;

  switch (tx_version) {
    case "0x0": {
      return invokeV0(tx);
    }

    case "0x1": {
      return invokeV1(tx);
    }

    case "0x3": {
      return invokeV3(tx);
    }
    default: {
      throw new Error(`Unsupported Invoke transaction version: ${tx_version}`);
    }
  }
}

async function invokeV0(
  tx: starknet.TransactionWithHash,
) {
  type INVOKE_TXN_V0 = {
    type: "INVOKE";
    max_fee: starknet.FELT;
    version: "0x0";
    signature: starknet.Signature;
    contract_address: string;
    entry_point_selector: starknet.FELT;
    calldata: starknet.FELT[];
  };

  let txn = tx as unknown as INVOKE_TXN_V0;

  const result = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_bypassAddInvokeTransaction",
    params: [
      {
        type: "INVOKE",
        max_fee: txn.max_fee,
        version: txn.version,
        signature: txn.signature,
        contract_address: txn.contract_address,
        entry_point_selector: txn.entry_point_selector,
        calldata: txn.calldata,
      },
    ],
  });

  return result.data.result.transaction_hash;
}

async function invokeV1(
  tx: starknet.TransactionWithHash,
) {
  type INVOKE_TXN_V1 = {
    type: "INVOKE";
    sender_address: string;
    calldata: starknet.FELT[];
    max_fee: starknet.FELT;
    version: "0x1";
    signature: starknet.Signature;
    nonce: starknet.FELT;
  };

  let txn = tx as unknown as INVOKE_TXN_V1;

  const result = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_bypassAddInvokeTransaction",
    params: [
      {
        type: "INVOKE",
        sender_address: txn.sender_address,
        calldata: txn.calldata,
        max_fee: txn.max_fee,
        version: txn.version,
        signature: txn.signature,
        nonce: txn.nonce,
      },
    ],
  });

  return result.data.result.transaction_hash;
}

async function invokeV3(
  tx: starknet.TransactionWithHash,
) {
  type INVOKE_TXN_V3 = {
    type: "INVOKE";
    sender_address: string;
    calldata: starknet.FELT[];
    version: "0x3";
    signature: starknet.Signature;
    nonce: starknet.FELT;
    resource_bounds: starknet.ResourceBounds;
    tip: string; // u64 is internally a string
    paymaster_data: starknet.FELT[];
    account_deployment_data: starknet.FELT[];
    nonce_data_availability_mode: starknet.EDataAvailabilityMode;
    fee_data_availability_mode: starknet.EDataAvailabilityMode;
  };

  let txn = tx as unknown as INVOKE_TXN_V3;

  const result = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_bypassAddInvokeTransaction",
    params: [
      {
        type: "INVOKE",
        sender_address: txn.sender_address,
        calldata: txn.calldata,
        version: txn.version,
        signature: txn.signature,
        nonce: txn.nonce,
        resource_bounds: txn.resource_bounds,
        tip: txn.tip,
        paymaster_data: txn.paymaster_data,
        account_deployment_data: txn.account_deployment_data,
        nonce_data_availability_mode: txn.nonce_data_availability_mode,
        fee_data_availability_mode: txn.fee_data_availability_mode,
      },
    ],
  });

  return result.data.result.transaction_hash;
}
