import assert from "node:assert/strict";
import test from "node:test";
import { ReplayMode } from "../src/constants.js";
import {
  isBoundaryReplayMode,
  parseReplayMode,
  shouldValidateBlockHash,
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

test("replay mode capabilities preserve boundary pacing and hash validation", () => {
  assert.equal(isBoundaryReplayMode(ReplayMode.MANAGED_BLOCKS), false);
  assert.equal(isBoundaryReplayMode(ReplayMode.TRANSACTION_ONLY), true);
  assert.equal(
    isBoundaryReplayMode(ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION),
    true,
  );
  assert.equal(shouldValidateBlockHash(ReplayMode.TRANSACTION_ONLY), false);
  assert.equal(
    shouldValidateBlockHash(ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION),
    true,
  );
});

test("parseReplayMode rejects invalid values", () => {
  assert.throws(
    () => parseReplayMode("headers_only"),
    /Invalid REPLAY_MODE value/,
  );
});
