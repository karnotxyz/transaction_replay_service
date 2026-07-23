import assert from "node:assert/strict";
import test from "node:test";
import { TransactionStatusMismatchError } from "../src/errors/index.js";

process.env.RPC_URL_ORIGINAL_NODE ??= "http://original.example";
process.env.RPC_URL_SYNCING_NODE ??= "http://syncing.example";
process.env.ADMIN_RPC_URL_SYNCING_NODE ??= "http://admin.example";

const {
  assertTransactionExecutionStatusMatches,
  getReceiptExecutionStatus,
  waitForTransactionExecutionStatus,
} = await import("../src/operations/transactionOperations.js");

test("getReceiptExecutionStatus returns SUCCEEDED for successful receipts", () => {
  assert.equal(
    getReceiptExecutionStatus({
      isSuccess: () => true,
      isReverted: () => false,
    } as any),
    "SUCCEEDED",
  );
});

test("getReceiptExecutionStatus returns REVERTED for reverted receipts", () => {
  assert.equal(
    getReceiptExecutionStatus({
      isSuccess: () => false,
      isReverted: () => true,
    } as any),
    "REVERTED",
  );
});

test("getReceiptExecutionStatus falls back to raw execution_status", () => {
  assert.equal(
    getReceiptExecutionStatus({
      isSuccess: () => false,
      isReverted: () => false,
      execution_status: "SUCCEEDED",
    } as any),
    "SUCCEEDED",
  );
});

test("assertTransactionExecutionStatusMatches allows matching statuses", () => {
  assert.doesNotThrow(() =>
    assertTransactionExecutionStatusMatches(
      2460006,
      "0x123",
      0,
      "REVERTED",
      "REVERTED",
    ),
  );
});

test("assertTransactionExecutionStatusMatches throws on mismatches", () => {
  assert.throws(
    () =>
      assertTransactionExecutionStatusMatches(
        2460006,
        "0x123",
        0,
        "SUCCEEDED",
        "REVERTED",
      ),
    TransactionStatusMismatchError,
  );
});

test("waitForTransactionExecutionStatus honors caller timeout", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      waitForTransactionExecutionStatus(
        { getTransactionReceipt: async () => ({}) } as any,
        "0x123",
        1,
      ),
    /Receipt validation timed out/,
  );

  assert.ok(Date.now() - startedAt < 2000);
});
