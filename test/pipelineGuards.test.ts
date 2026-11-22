import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExecutionBoxHealthy,
  assertReplayBoundaryClosed,
  assertReplayBoundaryMet,
} from "../src/sync/pipelineGuards.js";
import { ExecutionBoxStatus, ReplayBoundaryStatus } from "../src/types.js";

const boundary = (
  overrides: Partial<ReplayBoundaryStatus> = {},
): ReplayBoundaryStatus => ({
  block_n: 42,
  expected_tx_count: 3,
  dispatched_tx_count: 3,
  executed_tx_count: 3,
  last_executed_tx_hash: "0x3",
  reached_last_tx_hash: true,
  boundary_met: true,
  closed: true,
  mismatch: null,
  ...overrides,
});

const executionBox = (
  overrides: Partial<ExecutionBoxStatus> = {},
): ExecutionBoxStatus => ({
  mode: "mixed",
  startup_mode: "mixed",
  startup_recovery_active: false,
  reason: null,
  taint_block: null,
  replay_from: null,
  replay_to: null,
  replay_cursor: null,
  replay_backlog_empty: true,
  replay_supported: true,
  comparator_enabled: true,
  reexec_epoch: 7,
  ...overrides,
});

test("boundary guards accept exact met and closed state", () => {
  assert.doesNotThrow(() => assertReplayBoundaryMet(boundary(), 42, 3));
  assert.doesNotThrow(() => assertReplayBoundaryClosed(boundary(), 42, 3));
});

test("boundary guards fail immediately on mismatch or excess dispatch", () => {
  assert.throws(
    () => assertReplayBoundaryMet(boundary({ mismatch: "wrong tx" }), 42, 3),
    /Replay boundary mismatch/,
  );
  assert.throws(
    () =>
      assertReplayBoundaryMet(
        boundary({ dispatched_tx_count: 4, executed_tx_count: 4 }),
        42,
        3,
      ),
    /Replay boundary count mismatch/,
  );
  assert.throws(
    () =>
      assertReplayBoundaryClosed(
        boundary({ boundary_met: false, closed: true }),
        42,
        3,
      ),
    /closed before it was met/,
  );
});

test("execution box guard accepts healthy mixed mode", () => {
  assert.doesNotThrow(() => assertExecutionBoxHealthy(executionBox(), 7));
});

test("execution box guard rejects fallback, taint, replay, and epoch changes", () => {
  assert.throws(
    () =>
      assertExecutionBoxHealthy(
        executionBox({
          mode: "blockifier_only",
          comparator_enabled: false,
          taint_block: 42,
          reason: "state_diff_mismatch",
          replay_backlog_empty: false,
          replay_from: 42,
          replay_to: 51,
          replay_cursor: 43,
          reexec_epoch: 8,
        }),
        7,
      ),
    /mode=blockifier_only.*comparator_enabled=false.*taint_block=42.*state_diff_mismatch.*fallback_replay=42\.\.51@43.*reexec_epoch=8/,
  );
});
