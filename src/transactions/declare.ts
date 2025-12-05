import * as starknet from "starknet";
import { postWithRetry, getNonce } from "../utils.js";
import { config } from "../config.js";
import { originalProvider_v9, originalProvider_v8 } from "../providers.js";
import { writeFile } from "fs/promises";
import * as path from "path";
import * as fs from "fs";

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

  const result = await postWithRetry(config.rpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "starknet_addDeclareTransaction",
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

  let contractClass = await originalProvider_v9.getClassByHash(txn.class_hash);

  contractClass.entry_points_by_type.EXTERNAL.forEach((entry) => {
    let typedEntry = entry as starknet.ContractEntryPointFields;
    if (typeof typedEntry.offset === "number") {
      typedEntry.offset = "0x" + typedEntry.offset.toString(16);
    }
  });

  let transaction = {
    contract: contractClass as starknet.ContractClass,
    senderAddress: txn.sender_address,
    signature: txn.signature,
  };

  let invocationDetails = {
    nonce: txn.nonce,
    maxFee: txn.max_fee,
    version: txn.version,
  };

  let declareTransactionResult = await syncingProvider.declareContract(
    transaction,
    invocationDetails,
  );

  return declareTransactionResult.transaction_hash;
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

  let contract_class = await originalProvider_v8.getClassByHash(txn.class_hash);

  let contract_class_parsed = starknet.provider.parseContract({
    // @ts-ignore
    sierra_program: (contract_class as starknet.SierraContractClass)
      .sierra_program,
    contract_class_version: (contract_class as starknet.SierraContractClass)
      .contract_class_version,
    entry_points_by_type: (contract_class as starknet.SierraContractClass)
      .entry_points_by_type,
    //@ts-ignore
    abi: (contract_class as starknet.SierraContractClass).abi,
  });

  let x: starknet.SierraContractClass = {
    sierra_program: (contract_class_parsed as starknet.SierraContractClass)
      .sierra_program,
    //@ts-ignore
    abi: contract_class_parsed.abi,
    contract_class_version: (
      contract_class_parsed as starknet.SierraContractClass
    ).contract_class_version,
    entry_points_by_type: (
      contract_class_parsed as starknet.SierraContractClass
    ).entry_points_by_type,
  };

  let transaction = {
    contract: x,
    senderAddress: txn.sender_address,
    signature: txn.signature,
    compiledClassHash: txn.compiled_class_hash,
  };

  let invocationDetails = {
    nonce: txn.nonce,
    maxFee: txn.max_fee,
    version: txn.version,
  };

  let declareTransactionResult = await syncingProvider.declareContract(
    transaction,
    invocationDetails,
  );

  return declareTransactionResult.transaction_hash;
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

  let contract_class = await originalProvider_v9.getClassByHash(txn.class_hash);
  // Ensure tip is a hex string (NumAsHex expects hex string)
  let tipValue = txn.tip;
  if (typeof tipValue !== "string") {
    tipValue = String(tipValue);
  }
  if (!tipValue.startsWith("0x")) {
    tipValue = "0x" + BigInt(tipValue).toString(16);
  }

  // Ensure enum fields are strings
  const feeDataAvailabilityMode = String(txn.fee_data_availability_mode);
  const nonceDataAvailabilityMode = String(txn.nonce_data_availability_mode);

  const dummyAccount = new starknet.Account({
    provider: syncingProvider,
    address: txn.sender_address,
    signer: '0x123',
    transactionVersion: '0x3',
  });

  // Convert resource_bounds strings to bigint for ResourceBoundsBN
  // Handle cases where fields might be undefined or already BigInt
  const convertToBigInt = (value: any): bigint => {
    if (value === undefined || value === null) {
      return 0n;
    }
    if (typeof value === 'bigint') {
      return value;
    }
    try {
      return BigInt(value);
    } catch (error) {
      console.error("Error converting to BigInt:", value, error);
      return 0n;
    }
  };

  const resourceBoundsBN: starknet.ResourceBoundsBN = {
    l1_gas: {
      max_amount: convertToBigInt(txn.resource_bounds.l1_gas?.max_amount),
      max_price_per_unit: convertToBigInt(txn.resource_bounds.l1_gas?.max_price_per_unit),
    },
    l2_gas: {
      max_amount: convertToBigInt(txn.resource_bounds.l2_gas?.max_amount),
      max_price_per_unit: convertToBigInt(txn.resource_bounds.l2_gas?.max_price_per_unit),
    },
    l1_data_gas: {
      max_amount: convertToBigInt(txn.resource_bounds.l1_data_gas?.max_amount),
      max_price_per_unit: convertToBigInt(txn.resource_bounds.l1_data_gas?.max_price_per_unit),
    },
  };

  // Convert all V3TransactionDetails fields to BigInt as required
  const nonceBigInt = convertToBigInt(txn.nonce);
  const versionBigInt = convertToBigInt(txn.version);
  const tipBigInt = tipValue && tipValue !== '' ? BigInt(tipValue) : 0n;
  const paymasterDataBigInt = (txn.paymaster_data || []).map(item => convertToBigInt(item));
  const accountDeploymentDataBigInt = (txn.account_deployment_data || []).map(item => convertToBigInt(item));

  let payload;
  try {
    payload = await dummyAccount.buildDeclarePayload(
        // @ts-ignore
      { contract: contract_class, compiledClassHash: txn.compiled_class_hash },
      {
        nonce: nonceBigInt,
        version: '0x3',
        resourceBounds: resourceBoundsBN,
        tip: tipBigInt,
        paymasterData: paymasterDataBigInt,
        accountDeploymentData: accountDeploymentDataBigInt,
        nonceDataAvailabilityMode: nonceDataAvailabilityMode as starknet.EDataAvailabilityMode,
        feeDataAvailabilityMode: feeDataAvailabilityMode as starknet.EDataAvailabilityMode,
        walletAddress: txn.sender_address,
        chainId: await syncingProvider.getChainId(),
      }
    );
  } catch (error) {
    console.error("Error in buildDeclarePayload:", error);
    throw error;
  }

  const result = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_bypassAddDeclareTransaction",
    params: {
        declare_transaction: {
          type: "DECLARE",
          sender_address: txn.sender_address,
          compiled_class_hash: txn.compiled_class_hash,
          version: txn.version,
          signature: txn.signature,
          nonce: txn.nonce,
          contract_class: {
            // @ts-ignore
            sierra_program: contract_class.sierra_program,
            // @ts-ignore
            contract_class_version: payload.contract.contract_class_version,
            entry_points_by_type: payload.contract.entry_points_by_type,
            abi: payload.contract.abi,
          },
          resource_bounds: txn.resource_bounds,
          tip: tipValue,
          paymaster_data: txn.paymaster_data,
          account_deployment_data: txn.account_deployment_data,
          nonce_data_availability_mode: nonceDataAvailabilityMode,
          fee_data_availability_mode: feeDataAvailabilityMode
        }
      }
  });
  
  return result.data.result.transaction_hash;
}
