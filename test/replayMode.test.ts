import assert from "node:assert/strict";
import test from "node:test";
import { ReplayMode } from "../src/constants.js";
import { parseReplayMode } from "../src/replayMode.js";

test("parseReplayMode defaults to managed blocks", () => {
  assert.equal(parseReplayMode(undefined), ReplayMode.MANAGED_BLOCKS);
});

test("parseReplayMode accepts transaction-only mode", () => {
  assert.equal(
    parseReplayMode("transaction_only"),
    ReplayMode.TRANSACTION_ONLY,
  );
});

test("parseReplayMode rejects invalid values", () => {
  assert.throws(
    () => parseReplayMode("headers_only"),
    /Invalid REPLAY_MODE value/,
  );
});
