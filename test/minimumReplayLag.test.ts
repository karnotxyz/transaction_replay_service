import assert from "node:assert/strict";
import test from "node:test";

test("replay waits at the configured gap and follows the confirmed source head", async (t) => {
  process.env.RPC_URL_ORIGINAL_NODE = "http://original.example";
  process.env.RPC_URL_SYNCING_NODE = "http://syncing.example";
  process.env.ADMIN_RPC_URL_SYNCING_NODE = "http://syncing.example:9943";
  process.env.MIN_REPLAY_LAG_BLOCKS = "5";
  process.env.REPLAY_MODE = "managed_blocks";
  process.env.REPLAY_BLOCK_RPC_ENABLED = "true";
  process.env.MANAGED_BLOCK_MAX_INFLIGHT = "1";

  const { originalProvider, syncingProvider } =
    await import("../src/providers.js");
  const { getLatestReplayTarget } =
    await import("../src/operations/blockOperations.js");
  const { persistence } = await import("../src/persistence.js");
  const { probeManager } = await import("../src/probe/index.js");
  const { syncStateManager } = await import("../src/state/index.js");
  const { startSync } = await import("../src/sync.js");

  let sourceHead = 4;
  t.mock.method(originalProvider, "getBlockLatestAccepted", async () => ({
    block_number: sourceHead,
    block_hash: "0x1",
  }));
  t.mock.method(syncingProvider, "getBlockLatestAccepted", async () => ({
    block_number: 95,
    block_hash: "0x2",
  }));
  t.mock.method(persistence, "readState", () => null);
  t.mock.method(persistence, "writeState", () => {});
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

  assert.equal(await getLatestReplayTarget(), -1);
  sourceHead = 5;
  assert.equal(await getLatestReplayTarget(), 0);
  sourceHead = 100;
  await assert.rejects(startSync(96), /latest eligible block 95/);
  assert.equal((await startSync(95)).alreadyComplete, true);

  // Auto-resume supplies the next block from the saved cursor.
  const result = await startSync("latest", 96);
  const sync = syncStateManager.getProcess();
  assert.ok(sync);
  try {
    assert.equal(result.alreadyComplete, undefined);
    assert.equal(result.estimatedBlocks, 0);
    assert.equal(sync.syncTo, 95);
    assert.equal(sync.processedBlocks, 0);

    sourceHead = 101;
    await probeManager.probeForNewBlocks(sync);
    assert.equal(sync.syncTo, 96);
    assert.equal(sync.totalBlocks, 1);

    sourceHead = 99;
    await probeManager.probeForNewBlocks(sync);
    assert.equal(sync.syncTo, 94);
    assert.equal(sync.totalBlocks, 0);
  } finally {
    sync.cancelRequested = true;
    t.mock.timers.tick(5000);
    syncStateManager.clearProcess();
  }
});
