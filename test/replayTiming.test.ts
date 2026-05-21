import assert from "node:assert/strict";
import test from "node:test";
import { resolveReplayTimingConfig } from "../src/replayTiming.js";

test("resolveReplayTimingConfig uses reduced catch-up defaults", () => {
  const config = resolveReplayTimingConfig({});

  assert.equal(config.preConfirmedPollIntervalMs, 100);
  assert.equal(config.preConfirmedValidationTimeoutMs, 100000);
  assert.equal(config.receiptValidationInitialDelayMs, 100);
  assert.equal(config.receiptValidationPhase1IntervalMs, 50);
  assert.equal(config.sourceBlockPrefetchCount, 5);
});

test("resolveReplayTimingConfig accepts explicit overrides", () => {
  const config = resolveReplayTimingConfig({
    PRE_CONFIRMED_POLL_INTERVAL_MS: "50",
    PRE_CONFIRMED_VALIDATION_TIMEOUT_MS: "30000",
    RECEIPT_VALIDATION_INITIAL_DELAY_MS: "0",
    RECEIPT_VALIDATION_PHASE1_INTERVAL_MS: "25",
    SOURCE_BLOCK_PREFETCH_COUNT: "7",
  });

  assert.equal(config.preConfirmedPollIntervalMs, 50);
  assert.equal(config.preConfirmedValidationTimeoutMs, 30000);
  assert.equal(config.receiptValidationInitialDelayMs, 0);
  assert.equal(config.receiptValidationPhase1IntervalMs, 25);
  assert.equal(config.sourceBlockPrefetchCount, 7);
});

test("resolveReplayTimingConfig rejects invalid values", () => {
  assert.throws(
    () =>
      resolveReplayTimingConfig({
        PRE_CONFIRMED_POLL_INTERVAL_MS: "0",
      }),
    /PRE_CONFIRMED_POLL_INTERVAL_MS/,
  );
  assert.throws(
    () =>
      resolveReplayTimingConfig({
        PRE_CONFIRMED_VALIDATION_TIMEOUT_MS: "-1",
      }),
    /PRE_CONFIRMED_VALIDATION_TIMEOUT_MS/,
  );
  assert.throws(
    () =>
      resolveReplayTimingConfig({
        RECEIPT_VALIDATION_INITIAL_DELAY_MS: "-1",
      }),
    /RECEIPT_VALIDATION_INITIAL_DELAY_MS/,
  );
  assert.throws(
    () =>
      resolveReplayTimingConfig({
        RECEIPT_VALIDATION_PHASE1_INTERVAL_MS: "0",
      }),
    /RECEIPT_VALIDATION_PHASE1_INTERVAL_MS/,
  );
  assert.throws(
    () =>
      resolveReplayTimingConfig({
        SOURCE_BLOCK_PREFETCH_COUNT: "-1",
      }),
    /SOURCE_BLOCK_PREFETCH_COUNT/,
  );
});
