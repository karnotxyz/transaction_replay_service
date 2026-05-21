import * as starknet from "starknet";
import logger from "../logger.js";
import { config } from "../config.js";
import { originalProvider, syncingProvider } from "../providers.js";
import { L1HandlerConfig } from "../constants.js";
import { GasPrices, MadaraRpcResponse } from "../types.js";
import { postWithRetry } from "./transactionOperations.js";

interface SourceBlockWithTxs {
  block_hash?: string;
  timestamp?: number;
  l1_gas_price?: GasPrices["l1_gas_price"];
  l1_data_gas_price?: GasPrices["l1_data_gas_price"];
  l2_gas_price?: GasPrices["l2_gas_price"];
  transactions: starknet.TransactionWithHash[];
}

interface ReplayBlockCustomHeader {
  block_n: number;
  timestamp: number | undefined;
  gas_prices: {
    eth_l1_gas_price: number;
    strk_l1_gas_price: number;
    eth_l1_data_gas_price: number;
    strk_l1_data_gas_price: number;
    eth_l2_gas_price: number;
    strk_l2_gas_price: number;
  };
  expected_block_hash: string;
}

type ReplayBlockTransaction =
  | {
      kind: "invoke";
      transaction_hash: string;
      invoke_transaction: Record<string, unknown>;
    }
  | {
      kind: "declare_v0";
      transaction_hash: string;
      declare_transaction: Record<string, unknown>;
    }
  | {
      kind: "declare";
      transaction_hash: string;
      declare_transaction: Record<string, unknown>;
    }
  | {
      kind: "deploy_account";
      transaction_hash: string;
      deploy_account_transaction: Record<string, unknown>;
    }
  | {
      kind: "l1_handler";
      transaction_hash: string;
      l1_handler_message: Record<string, unknown>;
    };

interface ReplayBlockRequest {
  custom_header: ReplayBlockCustomHeader;
  transactions: ReplayBlockTransaction[];
}

export interface ReplayBlockResult {
  block_number: number;
  block_hash: string;
  transaction_hashes: string[];
}

type LegacyContractClass = starknet.ContractClass & {
  entry_points_by_type?: Record<string, Array<{ offset?: number | string }>>;
};

const classByHashCache = new Map<string, Promise<unknown>>();
let syncingChainIdPromise: Promise<string> | undefined;

async function getClassByHashCached(classHash: string): Promise<unknown> {
  let cached = classByHashCache.get(classHash);
  if (!cached) {
    cached = originalProvider.getClassByHash(classHash);
    classByHashCache.set(classHash, cached);
  }
  return cached;
}

async function getSyncingChainIdCached(): Promise<string> {
  if (!syncingChainIdPromise) {
    syncingChainIdPromise = syncingProvider.getChainId();
  }
  return syncingChainIdPromise;
}

function normalizeLegacyContractClass(contractClass: unknown): Record<string, unknown> {
  const normalized = contractClass as LegacyContractClass;
  const entryPointsByType = normalized.entry_points_by_type;

  if (entryPointsByType) {
    for (const entryPoints of Object.values(entryPointsByType)) {
      entryPoints.forEach((entry) => {
        const legacyEntry = entry as { offset?: string | number };
        if (typeof legacyEntry.offset === "number") {
          legacyEntry.offset = `0x${legacyEntry.offset.toString(16)}`;
        }
      });
    }
  }

  return normalized as unknown as Record<string, unknown>;
}

function convertToBigInt(value: unknown): bigint {
  if (value === undefined || value === null) {
    return 0n;
  }
  if (typeof value === "bigint") {
    return value;
  }
  return BigInt(value as string | number);
}

function buildCustomHeader(
  blockNumber: number,
  sourceBlock: SourceBlockWithTxs,
): ReplayBlockCustomHeader {
  if (!sourceBlock.block_hash) {
    throw new Error(`Block ${blockNumber} is pending - cannot replay`);
  }

  const gasPrices: GasPrices = {
    l1_data_gas_price: sourceBlock.l1_data_gas_price!,
    l1_gas_price: sourceBlock.l1_gas_price!,
    l2_gas_price: sourceBlock.l2_gas_price!,
  };

  return {
    block_n: blockNumber,
    timestamp: sourceBlock.timestamp,
    gas_prices: {
      eth_l1_gas_price: parseInt(gasPrices.l1_gas_price.price_in_wei, 16),
      strk_l1_gas_price: parseInt(gasPrices.l1_gas_price.price_in_fri, 16),
      eth_l1_data_gas_price: parseInt(
        gasPrices.l1_data_gas_price.price_in_wei,
        16,
      ),
      strk_l1_data_gas_price: parseInt(
        gasPrices.l1_data_gas_price.price_in_fri,
        16,
      ),
      eth_l2_gas_price: parseInt(gasPrices.l2_gas_price.price_in_wei, 16),
      strk_l2_gas_price: parseInt(gasPrices.l2_gas_price.price_in_fri, 16),
    },
    expected_block_hash: sourceBlock.block_hash,
  };
}

function buildInvokeReplayTransaction(
  tx: starknet.TransactionWithHash,
): ReplayBlockTransaction {
  const transaction = tx as Record<string, unknown>;

  return {
    kind: "invoke",
    transaction_hash: tx.transaction_hash,
    invoke_transaction: {
      type: "INVOKE",
      ...transaction,
    },
  };
}

async function buildDeclareReplayTransaction(
  tx: starknet.TransactionWithHash,
): Promise<ReplayBlockTransaction> {
  const txn = tx as Record<string, unknown>;
  const version = String(tx.version);
  const classHash = String(txn.class_hash);

  switch (version) {
    case "0x0": {
      const contractClass = normalizeLegacyContractClass(
        await getClassByHashCached(classHash),
      );
      return {
        kind: "declare_v0",
        transaction_hash: tx.transaction_hash,
        declare_transaction: {
          contract_class: contractClass,
          max_fee: txn.max_fee,
          sender_address: txn.sender_address,
          signature: txn.signature,
          is_query: false,
        },
      };
    }

    case "0x1": {
      const contractClass = normalizeLegacyContractClass(
        await getClassByHashCached(classHash),
      );
      return {
        kind: "declare",
        transaction_hash: tx.transaction_hash,
        declare_transaction: {
          type: "DECLARE",
          version,
          contract_class: contractClass,
          max_fee: txn.max_fee,
          nonce: txn.nonce,
          sender_address: txn.sender_address,
          signature: txn.signature,
        },
      };
    }

    case "0x2": {
      const contractClass = (await getClassByHashCached(
        classHash,
      )) as starknet.SierraContractClass;

      const parsedContractClass = starknet.provider.parseContract({
        sierra_program: contractClass.sierra_program,
        contract_class_version: contractClass.contract_class_version,
        entry_points_by_type: contractClass.entry_points_by_type,
        abi: contractClass.abi,
      } as any) as starknet.SierraContractClass;

      return {
        kind: "declare",
        transaction_hash: tx.transaction_hash,
        declare_transaction: {
          type: "DECLARE",
          version,
          compiled_class_hash: txn.compiled_class_hash,
          contract_class: {
            sierra_program: parsedContractClass.sierra_program,
            abi: parsedContractClass.abi,
            contract_class_version: parsedContractClass.contract_class_version,
            entry_points_by_type: parsedContractClass.entry_points_by_type,
          },
          max_fee: txn.max_fee,
          nonce: txn.nonce,
          sender_address: txn.sender_address,
          signature: txn.signature,
        },
      };
    }

    case "0x3": {
      const contractClass = await getClassByHashCached(classHash);
      const tipValue = String(txn.tip).startsWith("0x")
        ? String(txn.tip)
        : `0x${BigInt(String(txn.tip)).toString(16)}`;
      const feeDataAvailabilityMode = String(
        txn.fee_data_availability_mode,
      );
      const nonceDataAvailabilityMode = String(
        txn.nonce_data_availability_mode,
      );

      const dummyAccount = new starknet.Account({
        provider: syncingProvider,
        address: String(txn.sender_address),
        signer: "0x123",
        transactionVersion: "0x3",
      });

      const resourceBounds = txn.resource_bounds as starknet.ResourceBounds;
      const resourceBoundsBN: starknet.ResourceBoundsBN = {
        l1_gas: {
          max_amount: convertToBigInt(resourceBounds.l1_gas?.max_amount),
          max_price_per_unit: convertToBigInt(
            resourceBounds.l1_gas?.max_price_per_unit,
          ),
        },
        l2_gas: {
          max_amount: convertToBigInt(resourceBounds.l2_gas?.max_amount),
          max_price_per_unit: convertToBigInt(
            resourceBounds.l2_gas?.max_price_per_unit,
          ),
        },
        l1_data_gas: {
          max_amount: convertToBigInt(resourceBounds.l1_data_gas?.max_amount),
          max_price_per_unit: convertToBigInt(
            resourceBounds.l1_data_gas?.max_price_per_unit,
          ),
        },
      };

      const payload = await dummyAccount.buildDeclarePayload(
        {
          // @ts-ignore starknet.js accepts the class returned by the provider here.
          contract: contractClass,
          compiledClassHash: String(txn.compiled_class_hash),
        },
        {
          nonce: convertToBigInt(txn.nonce),
          version: "0x3",
          resourceBounds: resourceBoundsBN,
          tip: BigInt(tipValue),
          paymasterData: (txn.paymaster_data as Array<unknown> | undefined)?.map(convertToBigInt) || [],
          accountDeploymentData:
            (txn.account_deployment_data as Array<unknown> | undefined)?.map(convertToBigInt) || [],
          nonceDataAvailabilityMode:
            nonceDataAvailabilityMode as starknet.EDataAvailabilityMode,
          feeDataAvailabilityMode:
            feeDataAvailabilityMode as starknet.EDataAvailabilityMode,
          walletAddress: String(txn.sender_address),
          chainId: await getSyncingChainIdCached(),
        },
      );

      return {
        kind: "declare",
        transaction_hash: tx.transaction_hash,
        declare_transaction: {
          type: "DECLARE",
          version,
          sender_address: txn.sender_address,
          compiled_class_hash: txn.compiled_class_hash,
          signature: txn.signature,
          nonce: txn.nonce,
          contract_class: {
            // @ts-ignore starknet.js output is compatible with the RPC payload.
            sierra_program: contractClass.sierra_program,
            // @ts-ignore payload carries normalized ABI/version info.
            contract_class_version: payload.contract.contract_class_version,
            entry_points_by_type: payload.contract.entry_points_by_type,
            abi: payload.contract.abi,
          },
          resource_bounds: txn.resource_bounds,
          tip: tipValue,
          paymaster_data: txn.paymaster_data,
          account_deployment_data: txn.account_deployment_data,
          nonce_data_availability_mode: nonceDataAvailabilityMode,
          fee_data_availability_mode: feeDataAvailabilityMode,
        },
      };
    }

    default:
      throw new Error(`Unsupported Declare transaction version: ${version}`);
  }
}

function buildDeployAccountReplayTransaction(
  tx: starknet.TransactionWithHash,
): ReplayBlockTransaction {
  const transaction = tx as Record<string, unknown>;

  return {
    kind: "deploy_account",
    transaction_hash: tx.transaction_hash,
    deploy_account_transaction: {
      type: "DEPLOY_ACCOUNT",
      ...transaction,
    },
  };
}

function buildL1HandlerReplayTransaction(
  tx: starknet.TransactionWithHash,
): ReplayBlockTransaction {
  const txn = tx as Record<string, unknown>;

  return {
    kind: "l1_handler",
    transaction_hash: tx.transaction_hash,
    l1_handler_message: {
      tx: {
        version: txn.version,
        nonce: parseInt(String(txn.nonce), 16),
        contract_address: txn.contract_address,
        entry_point_selector: txn.entry_point_selector,
        calldata: txn.calldata,
      },
      paid_fee_on_l1: L1HandlerConfig.DEFAULT_PAID_FEE_HEX,
    },
  };
}

async function buildReplayTransaction(
  tx: starknet.TransactionWithHash,
): Promise<ReplayBlockTransaction> {
  switch (tx.type) {
    case "INVOKE":
      return buildInvokeReplayTransaction(tx);
    case "DECLARE":
      return buildDeclareReplayTransaction(tx);
    case "DEPLOY_ACCOUNT":
      return buildDeployAccountReplayTransaction(tx);
    case "L1_HANDLER":
      return buildL1HandlerReplayTransaction(tx);
    default:
      throw new Error(`Unsupported transaction type for replayBlock: ${tx.type}`);
  }
}

export async function buildReplayBlockRequest(
  blockNumber: number,
  sourceBlock: SourceBlockWithTxs,
): Promise<ReplayBlockRequest> {
  return {
    custom_header: buildCustomHeader(blockNumber, sourceBlock),
    transactions: await Promise.all(
      sourceBlock.transactions.map((tx) => buildReplayTransaction(tx)),
    ),
  };
}

export async function replayBlock(
  blockNumber: number,
  sourceBlock: SourceBlockWithTxs,
): Promise<ReplayBlockResult> {
  const request = await buildReplayBlockRequest(blockNumber, sourceBlock);
  logger.info(
    `📦 Replaying block ${blockNumber} via madara_V0_1_0_replayBlock with ${request.transactions.length} transactions`,
  );

  const response = await postWithRetry(config.adminRpcUrlSyncingNode, {
    id: 1,
    jsonrpc: "2.0",
    method: "madara_V0_1_0_replayBlock",
    params: [request],
  });

  const rpcResponse = response.data as MadaraRpcResponse;
  if (rpcResponse.error) {
    throw new Error(
      `RPC Error: ${rpcResponse.error.message} (Code: ${rpcResponse.error.code})`,
    );
  }

  return rpcResponse.result as ReplayBlockResult;
}
