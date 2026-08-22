import assert from "node:assert/strict";
import test from "node:test";
import { L1HandlerConfig } from "../src/constants.js";
import {
  buildReplayBlockRequest,
  validateReplayBlockResult,
} from "../src/operations/replayBlockOperations.js";
import { BlockHashMismatchError } from "../src/errors/index.js";

test("buildReplayBlockRequest encodes L1 handler fees as JSON numbers", async () => {
  const request = await buildReplayBlockRequest(9566025, {
    block_hash: "0x1575211d8eb22ff2a1e052aa1425ec7843e754317134ae3bbec25700a452d94",
    timestamp: 1778208479,
    l1_gas_price: { price_in_wei: "0x490b6e72", price_in_fri: "0x37cf307d727b" },
    l1_data_gas_price: { price_in_wei: "0x186d98", price_in_fri: "0x12aa056898" },
    l2_gas_price: { price_in_wei: "0x66e0d", price_in_fri: "0x4e9a87300" },
    transactions: [
      {
        calldata: [
          "0x651065427cb3022839764b142c6098c1833df6dd",
          "0x3febbb0c9f136552b16ce43374bbc947",
          "0x96596c1962a3b4948281940f10e1255",
        ],
        contract_address:
          "0x1794b8e558902e1e6a1d122d94de40fc7d482d11ea7f8e5cb56dd393646a378",
        entry_point_selector:
          "0x1ec02fa6378eca6ce8f976f7e74ad1a2241692571db908bc34270508d025cf4",
        nonce: "0x19d877",
        transaction_hash:
          "0x331c55c393c4a9f7f443b508da4a084c7926c04ad50802faec9523f9c49d1bf",
        type: "L1_HANDLER",
        version: "0x0",
      },
    ],
  } as any);

  assert.equal(request.transactions.length, 1);
  const [transaction] = request.transactions;

  assert.equal(transaction.kind, "l1_handler");
  assert.equal(
    (transaction as any).l1_handler_message.paid_fee_on_l1,
    L1HandlerConfig.DEFAULT_PAID_FEE,
  );
  assert.equal(
    JSON.parse(JSON.stringify(request)).transactions[0].l1_handler_message
      .paid_fee_on_l1,
    L1HandlerConfig.DEFAULT_PAID_FEE,
  );
});

test("validateReplayBlockResult gates advancement only when hash validation is enabled", () => {
  const result = {
    block_number: 42,
    block_hash: "0x0abc",
    transaction_hashes: [],
  };

  assert.doesNotThrow(() =>
    validateReplayBlockResult(42, "0xabc", true, result),
  );
  assert.doesNotThrow(() =>
    validateReplayBlockResult(42, "0xdef", false, result),
  );
  assert.throws(
    () => validateReplayBlockResult(42, "0xdef", true, result),
    BlockHashMismatchError,
  );
});

test("validateReplayBlockResult always requires the confirmed block identity", () => {
  assert.throws(
    () =>
      validateReplayBlockResult(42, "0xabc", false, {
        block_number: 41,
        block_hash: "0xabc",
        transaction_hashes: [],
      }),
    /returned block 41, expected 42/,
  );
  assert.throws(
    () =>
      validateReplayBlockResult(42, "0xabc", false, {
        block_number: 42,
        block_hash: "",
        transaction_hashes: [],
      }),
    /returned no block hash/,
  );
});
