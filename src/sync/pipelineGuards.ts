import { ExecutionBoxStatus, ReplayBoundaryStatus } from "../types.js";

export function assertReplayBoundaryMet(
  status: ReplayBoundaryStatus | null,
  blockNumber: number,
  expectedTxCount: number,
): asserts status is ReplayBoundaryStatus {
  if (!status) {
    throw new Error(
      `Replay boundary status not found for block ${blockNumber}`,
    );
  }
  if (status.block_n !== blockNumber) {
    throw new Error(
      `Replay boundary returned block ${status.block_n}, expected ${blockNumber}`,
    );
  }
  if (status.mismatch) {
    throw new Error(
      `Replay boundary mismatch for block ${blockNumber}: ${status.mismatch}`,
    );
  }
  if (
    status.expected_tx_count !== expectedTxCount ||
    status.dispatched_tx_count > expectedTxCount ||
    status.executed_tx_count > expectedTxCount
  ) {
    throw new Error(
      `Replay boundary count mismatch for block ${blockNumber}: expected=${expectedTxCount}, configured=${status.expected_tx_count}, dispatched=${status.dispatched_tx_count}, executed=${status.executed_tx_count}, reached_last_tx_hash=${status.reached_last_tx_hash}`,
    );
  }
  if (status.closed && !status.boundary_met) {
    throw new Error(
      `Replay boundary closed before it was met for block ${blockNumber}: executed=${status.executed_tx_count}, expected=${expectedTxCount}, reached_last_tx_hash=${status.reached_last_tx_hash}`,
    );
  }
  if (!status.boundary_met) {
    return;
  }
  if (
    status.expected_tx_count !== expectedTxCount ||
    status.dispatched_tx_count !== expectedTxCount ||
    status.executed_tx_count !== expectedTxCount ||
    !status.reached_last_tx_hash
  ) {
    throw new Error(
      `Replay boundary count mismatch for block ${blockNumber}: expected=${expectedTxCount}, configured=${status.expected_tx_count}, dispatched=${status.dispatched_tx_count}, executed=${status.executed_tx_count}, reached_last_tx_hash=${status.reached_last_tx_hash}`,
    );
  }
}

export function assertReplayBoundaryClosed(
  status: ReplayBoundaryStatus | null,
  blockNumber: number,
  expectedTxCount: number,
): asserts status is ReplayBoundaryStatus {
  assertReplayBoundaryMet(status, blockNumber, expectedTxCount);
}

export function assertExecutionBoxHealthy(
  status: ExecutionBoxStatus,
  expectedEpoch?: number,
): void {
  const problems: string[] = [];

  if (status.mode.toLowerCase() !== "mixed") {
    problems.push(`mode=${status.mode}`);
  }
  if (!status.comparator_enabled) {
    problems.push("comparator_enabled=false");
  }
  if (status.startup_recovery_active) {
    problems.push("startup_recovery_active=true");
  }
  if (status.taint_block !== null) {
    problems.push(`taint_block=${status.taint_block}`);
  }
  if (status.reason !== null) {
    problems.push(`reason=${status.reason}`);
  }
  if (!status.replay_backlog_empty) {
    problems.push(
      `fallback_replay=${status.replay_from ?? "?"}..${
        status.replay_to ?? "?"
      }@${status.replay_cursor ?? "?"}`,
    );
  }
  if (expectedEpoch !== undefined && status.reexec_epoch !== expectedEpoch) {
    problems.push(
      `reexec_epoch=${status.reexec_epoch}, expected=${expectedEpoch}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`ExecutionBox unhealthy: ${problems.join(", ")}`);
  }
}
