import type { BlockWithReceipts } from "../types.js";

interface ReplayResult {
  block_number: number;
  block_hash: string;
  transaction_hashes: string[];
}

export interface ManagedBlockValidationOptions {
  eventContractAddress?: string;
  eventDataPrefixLength?: number;
}

function sameFelt(a: string, b: string): boolean {
  return BigInt(a) === BigInt(b);
}

function assertEqual(label: string, source: unknown, target: unknown): void {
  if (source === undefined || target === undefined) {
    if (source === target) return;
    throw new Error(`${label} missing on one block: C1=${source}, C2=${target}`);
  }
  const a = typeof source === "string" && source.startsWith("0x") ? BigInt(source).toString() : String(source);
  const b = typeof target === "string" && target.startsWith("0x") ? BigInt(target).toString() : String(target);
  if (a !== b) throw new Error(`${label} differs: C1=${source}, C2=${target}`);
}

function compareGas(label: string, source: Record<string, string> | undefined, target: Record<string, string> | undefined): void {
  if (!source || !target) throw new Error(`${label} missing on one block`);
  for (const unit of ["price_in_wei", "price_in_fri"]) {
    assertEqual(`${label}.${unit}`, source[unit], target[unit]);
  }
}

export function validateManagedBlock(
  blockNumber: number,
  source: BlockWithReceipts,
  target: BlockWithReceipts,
  result: ReplayResult,
  options: ManagedBlockValidationOptions = {},
): void {
  assertEqual("source block number", blockNumber, source.block_number);
  assertEqual("target block number", blockNumber, target.block_number);
  assertEqual("RPC result block number", blockNumber, result.block_number);
  if (!target.block_hash || !sameFelt(target.block_hash, result.block_hash)) {
    throw new Error(`Returned C2 block hash does not identify confirmed block ${blockNumber}`);
  }
  assertEqual("timestamp", source.timestamp, target.timestamp);
  for (const field of ["starknet_version", "sequencer_address", "l1_da_mode"] as const) {
    assertEqual(field, source[field], target[field]);
  }
  compareGas("l1_gas_price", source.l1_gas_price, target.l1_gas_price);
  compareGas("l1_data_gas_price", source.l1_data_gas_price, target.l1_data_gas_price);
  compareGas("l2_gas_price", source.l2_gas_price, target.l2_gas_price);

  if (source.transactions.length !== target.transactions.length || result.transaction_hashes.length !== source.transactions.length) {
    throw new Error(`Block ${blockNumber} transaction count differs: C1=${source.transactions.length}, C2=${target.transactions.length}, RPC=${result.transaction_hashes.length}`);
  }
  for (let index = 0; index < source.transactions.length; index++) {
    const sourceTx = source.transactions[index];
    const targetTx = target.transactions[index];
    // Madara's getBlockWithReceipts puts the hash in the receipt; the nested
    // transaction object may omit it even though getBlockWithTxs includes it.
    const hash = sourceTx.receipt.transaction_hash;
    if (!hash || !targetTx.receipt.transaction_hash || !result.transaction_hashes[index] ||
        !sameFelt(hash, targetTx.receipt.transaction_hash) || !sameFelt(hash, result.transaction_hashes[index]) ||
        (sourceTx.transaction.transaction_hash && !sameFelt(hash, sourceTx.transaction.transaction_hash)) ||
        (targetTx.transaction.transaction_hash && !sameFelt(hash, targetTx.transaction.transaction_hash))) {
      throw new Error(`Block ${blockNumber} transaction ${index} hash/order differs`);
    }
    assertEqual(`transaction ${index} execution status`, sourceTx.receipt.execution_status, targetTx.receipt.execution_status);
    if (sourceTx.receipt.execution_status === "REVERTED") {
      assertEqual(`transaction ${index} revert reason`, sourceTx.receipt.revert_reason, targetTx.receipt.revert_reason);
    }
    type ReplayEvent = { from_address: string; keys: string[]; data: string[] };
    const sourceEvents = (sourceTx.receipt.events || []) as ReplayEvent[];
    const targetEvents = (targetTx.receipt.events || []) as ReplayEvent[];
    if (sourceEvents.length !== targetEvents.length) throw new Error(`Transaction ${hash} application event count differs`);
    for (let eventIndex = 0; eventIndex < sourceEvents.length; eventIndex++) {
      const a = sourceEvents[eventIndex];
      const b = targetEvents[eventIndex];
      if (!sameFelt(a.from_address, b.from_address) || a.keys.length !== b.keys.length || a.keys.some((key, i) => !sameFelt(key, b.keys[i]))) {
        throw new Error(`Transaction ${hash} event ${eventIndex} origin/keys differ`);
      }
      const fields = options.eventContractAddress && sameFelt(a.from_address, options.eventContractAddress)
        ? options.eventDataPrefixLength ?? a.data.length
        : a.data.length;
      if (a.data.length !== b.data.length || fields > a.data.length || a.data.slice(0, fields).some((value, i) => !sameFelt(value, b.data[i]))) {
        throw new Error(`Transaction ${hash} event ${eventIndex} data differs`);
      }
    }
  }
}
