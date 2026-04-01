import test from "node:test";
import assert from "node:assert/strict";
import {
  compareBlocks,
  evaluateBoundaryWindow,
} from "../src/reconcile/logic.js";

function createSnapshot(
  blockNumber: number,
  blockHash: string,
  txCount: number,
) {
  return {
    blockNumber,
    blockHash,
    txCount,
  };
}

test("evaluateBoundaryWindow returns healthy when all blocks match", () => {
  const comparisons = [
    compareBlocks(
      createSnapshot(10, "0xaaa", 2),
      createSnapshot(10, "0xaaa", 2),
    ),
    compareBlocks(
      createSnapshot(11, "0xbbb", 0),
      createSnapshot(11, "0xbbb", 0),
    ),
  ];

  const result = evaluateBoundaryWindow(comparisons);

  assert.equal(result.status, "healthy");
  assert.equal(result.firstBad, undefined);
  assert.equal(result.lastGood, undefined);
});

test("same-count hash mismatch is treated as a repairable boundary fault", () => {
  const comparisons = [
    compareBlocks(
      createSnapshot(20, "0xgood", 0),
      createSnapshot(20, "0xgood", 0),
    ),
    compareBlocks(
      createSnapshot(21, "0xlocal", 0),
      createSnapshot(21, "0xsource", 0),
    ),
  ];

  const result = evaluateBoundaryWindow(comparisons);

  assert.equal(result.status, "repairable");
  assert.equal(result.lastGood?.blockNumber, 20);
  assert.equal(result.firstBad?.blockNumber, 21);
});

test("tx-count mismatch is treated as a repairable boundary fault", () => {
  const comparisons = [
    compareBlocks(
      createSnapshot(30, "0xgood", 2),
      createSnapshot(30, "0xgood", 2),
    ),
    compareBlocks(
      createSnapshot(31, "0xsame", 0),
      createSnapshot(31, "0xsame", 3),
    ),
  ];

  const result = evaluateBoundaryWindow(comparisons);

  assert.equal(result.status, "repairable");
  assert.equal(result.lastGood?.blockNumber, 30);
  assert.equal(result.firstBad?.blockNumber, 31);
});

test("boundary search records the earliest mismatch and previous good block", () => {
  const comparisons = [
    compareBlocks(
      createSnapshot(40, "0x040", 1),
      createSnapshot(40, "0x040", 1),
    ),
    compareBlocks(
      createSnapshot(41, "0x041-local", 1),
      createSnapshot(41, "0x041-source", 1),
    ),
    compareBlocks(
      createSnapshot(42, "0x042-local", 2),
      createSnapshot(42, "0x042-source", 2),
    ),
  ];

  const result = evaluateBoundaryWindow(comparisons);

  assert.equal(result.status, "repairable");
  assert.equal(result.firstBad?.blockNumber, 41);
  assert.equal(result.lastGood?.blockNumber, 40);
});
