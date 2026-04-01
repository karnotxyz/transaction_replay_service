import test from "node:test";
import assert from "node:assert/strict";
import { waitForMadaraRecovery } from "../src/madara/health.js";

function createSequenceProbe(sequence: boolean[]) {
  let index = 0;
  let nowMs = 0;

  return {
    calls: () => index,
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    checkHealth: async () => {
      const current = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return current;
    },
  };
}

test("waitForMadaraRecovery waits to observe a down transition before accepting recovery", async () => {
  const probe = createSequenceProbe([true, true, false, true]);

  const recovered = await waitForMadaraRecovery({
    requireObservedDown: true,
    minHealthyChecks: 1,
    healthyCheckDelayMs: 1,
    checkHealth: probe.checkHealth,
    sleep: probe.sleep,
    now: probe.now,
    maxWaitMs: 30_000,
  });

  assert.equal(recovered, true);
  assert.equal(probe.calls(), 4);
});

test("waitForMadaraRecovery requires stable healthy checks after the node comes back", async () => {
  const probe = createSequenceProbe([false, true, false, true, true]);

  const recovered = await waitForMadaraRecovery({
    requireObservedDown: true,
    minHealthyChecks: 2,
    healthyCheckDelayMs: 1,
    checkHealth: probe.checkHealth,
    sleep: probe.sleep,
    now: probe.now,
    maxWaitMs: 30_000,
  });

  assert.equal(recovered, true);
  assert.equal(probe.calls(), 5);
});
