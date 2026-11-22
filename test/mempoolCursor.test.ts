import assert from "node:assert/strict";
import test from "node:test";
import { getMempoolTransactionSuffix } from "../src/sync/mempoolCursor.js";

test("selects only the first source block suffix", () => {
  assert.deepEqual(getMempoolTransactionSuffix(["a", "b", "c"], 1, 42), [
    "b",
    "c",
  ]);
  assert.deepEqual(getMempoolTransactionSuffix(["d", "e"], 0, 43), [
    "d",
    "e",
  ]);
});

test("rejects a cursor beyond the source block", () => {
  assert.throws(
    () => getMempoolTransactionSuffix(["a"], 2, 42),
    /Invalid mempool startTxIndex 2/,
  );
});
