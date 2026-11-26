import assert from "node:assert/strict";
import test from "node:test";
import { validateManagedBlock } from "../src/validation/managedBlockValidator.js";
import type { BlockWithReceipts } from "../src/types.js";

function block(hash: string, mode: string): BlockWithReceipts {
  const gas = { price_in_wei: "0x2", price_in_fri: "0x3" };
  return {
    block_hash: hash,
    block_number: 5,
    timestamp: 1234,
    starknet_version: "0.14.2",
    sequencer_address: "0x1",
    l1_da_mode: "BLOB",
    l1_gas_price: gas,
    l1_data_gas_price: gas,
    l2_gas_price: gas,
    transactions: [{
      transaction: { type: "INVOKE", nonce: "0x1" },
      receipt: {
        transaction_hash: "0xabc", actual_fee: { amount: "0x1", unit: "FRI" },
        execution_status: "SUCCEEDED", finality_status: "ACCEPTED_ON_L2", type: "INVOKE",
        messages_sent: [], events: [
          { from_address: "0x123", keys: ["0x99"], data: ["0x2a", "0x2f", mode] },
          { from_address: "0x456", keys: ["0x98"], data: ["0x1"] },
        ],
      },
    }],
  };
}

const eventOptions = { eventContractAddress: "0x123", eventDataPrefixLength: 2 };

test("managed replay accepts different block hash and read mode with matching headers and business events", () => {
  const source = block("0xaaa", "0x0");
  const target = block("0xbbb", "0x1");
  assert.doesNotThrow(() => validateManagedBlock(5, source, target, {
    block_number: 5, block_hash: "0xbbb", transaction_hashes: ["0xabc"],
  }, eventOptions));
});

test("managed replay rejects a changed timestamp, receipt status, or settlement value", () => {
  const source = block("0xaaa", "0x0");
  const result = { block_number: 5, block_hash: "0xbbb", transaction_hashes: ["0xabc"] };
  const timestamp = block("0xbbb", "0x1");
  timestamp.timestamp = 1235;
  assert.throws(() => validateManagedBlock(5, source, timestamp, result, eventOptions), /timestamp differs/);
  const status = block("0xbbb", "0x1");
  status.transactions[0].receipt.execution_status = "REVERTED";
  assert.throws(() => validateManagedBlock(5, source, status, result, eventOptions), /execution status differs/);
  const event = block("0xbbb", "0x1");
  event.transactions[0].receipt.events[0].data[1] = "0x30";
  assert.throws(() => validateManagedBlock(5, source, event, result, eventOptions), /event 0 data differs/);
  const unrelatedEvent = block("0xbbb", "0x1");
  unrelatedEvent.transactions[0].receipt.events[1].data[0] = "0x2";
  assert.throws(() => validateManagedBlock(5, source, unrelatedEvent, result, eventOptions), /event 1 data differs/);
});

test("managed replay rejects extra transactions or wrong returned hash", () => {
  const source = block("0xaaa", "0x0");
  const target = block("0xbbb", "0x1");
  target.transactions.push(target.transactions[0]);
  assert.throws(() => validateManagedBlock(5, source, target, {
    block_number: 5, block_hash: "0xbbb", transaction_hashes: ["0xabc"],
  }, eventOptions), /transaction count differs/);
  target.transactions.pop();
  assert.throws(() => validateManagedBlock(5, source, target, {
    block_number: 5, block_hash: "0xccc", transaction_hashes: ["0xabc"],
  }, eventOptions), /Returned C2 block hash/);
});

test("managed replay permits explicitly expected event data divergence while checking event identity", () => {
  const source = block("0xaaa", "0x0");
  const target = block("0xbbb", "0x1");
  target.transactions[0].receipt.events[0].data = ["0x3e8", "0x3ed", "0x1"];
  target.transactions[0].receipt.events[1].data = ["0x2"];
  const result = { block_number: 5, block_hash: "0xbbb", transaction_hashes: ["0xabc"] };
  assert.doesNotThrow(() => validateManagedBlock(5, source, target, result, { eventDataPrefixLength: 0 }));
  target.transactions[0].receipt.events[0].keys[0] = "0x100";
  assert.throws(() => validateManagedBlock(5, source, target, result, { eventDataPrefixLength: 0 }), /origin\/keys differ/);
});

test("restart validation ignores intentional event divergence but checks transaction outcomes", () => {
  const source = block("0xaaa", "0x0");
  const target = block("0xbbb", "0x1");
  target.transactions[0].receipt.events = [];
  const result = { block_number: 5, block_hash: "0xbbb", transaction_hashes: ["0xabc"] };
  assert.doesNotThrow(() => validateManagedBlock(5, source, target, result, { compareEvents: false }));
  target.transactions[0].receipt.execution_status = "REVERTED";
  assert.throws(() => validateManagedBlock(5, source, target, result, { compareEvents: false }), /execution status differs/);
});
