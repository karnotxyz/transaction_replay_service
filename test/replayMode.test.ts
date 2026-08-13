import assert from "node:assert/strict";
import test from "node:test";
import { ReplayMode } from "../src/constants.js";
import {
  isMempoolReplayMode,
  isTransactionReplayMode,
  parseReplayMode,
  shouldValidateBlockHash,
  usesReplayBoundaries,
} from "../src/replayMode.js";

test("parseReplayMode defaults to managed blocks", () => {
  assert.equal(parseReplayMode(undefined), ReplayMode.MANAGED_BLOCKS);
});

test("parseReplayMode accepts transaction-only mode", () => {
  assert.equal(
    parseReplayMode("transaction_only"),
    ReplayMode.TRANSACTION_ONLY,
  );
});

test("parseReplayMode accepts boundary replay with hash validation", () => {
  assert.equal(
    parseReplayMode("transaction_only_with_hash_validation"),
    ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION,
  );
});

test("parseReplayMode accepts mempool mode", () => {
  assert.equal(parseReplayMode("mempool"), ReplayMode.MEMPOOL);
});

test("replay mode capabilities preserve boundary pacing and hash validation", () => {
  assert.equal(isTransactionReplayMode(ReplayMode.MANAGED_BLOCKS), false);
  assert.equal(isTransactionReplayMode(ReplayMode.TRANSACTION_ONLY), true);
  assert.equal(
    isTransactionReplayMode(ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION),
    true,
  );
  assert.equal(isTransactionReplayMode(ReplayMode.MEMPOOL), true);
  assert.equal(usesReplayBoundaries(ReplayMode.MANAGED_BLOCKS), false);
  assert.equal(usesReplayBoundaries(ReplayMode.TRANSACTION_ONLY), true);
  assert.equal(
    usesReplayBoundaries(ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION),
    true,
  );
  assert.equal(usesReplayBoundaries(ReplayMode.MEMPOOL), false);
  assert.equal(isMempoolReplayMode(ReplayMode.MEMPOOL), true);
  assert.equal(isMempoolReplayMode(ReplayMode.TRANSACTION_ONLY), false);
  assert.equal(shouldValidateBlockHash(ReplayMode.TRANSACTION_ONLY), false);
  assert.equal(
    shouldValidateBlockHash(ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION),
    true,
  );
  assert.equal(shouldValidateBlockHash(ReplayMode.MEMPOOL), false);
});

test("parseReplayMode rejects invalid values", () => {
  assert.throws(
    () => parseReplayMode("headers_only"),
    /Invalid REPLAY_MODE value/,
  );
});
