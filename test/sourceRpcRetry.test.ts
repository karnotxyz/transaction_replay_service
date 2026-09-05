import assert from "node:assert/strict";
import test from "node:test";

process.env.RPC_URL_ORIGINAL_NODE = "http://original.test";
process.env.RPC_URL_SYNCING_NODE = "http://syncing.test";
process.env.ADMIN_RPC_URL_SYNCING_NODE = "http://syncing-admin.test";
process.env.OTEL_ENABLED = "false";

test("source block reads retry transient connectivity failures", async (t) => {
  const [{ getBlockWithTxs }, { originalProvider }] = await Promise.all([
    import("../src/operations/blockOperations.js"),
    import("../src/providers.js"),
  ]);
  let attempts = 0;
  t.mock.method(originalProvider, "getBlockWithTxs", async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error("fetch failed");
    }
    return { block_number: 42 } as never;
  });

  const block = await getBlockWithTxs(originalProvider, 42);

  assert.equal(block.block_number, 42);
  assert.equal(attempts, 2);
});

test("syncing block reads still surface connectivity failures immediately", async (t) => {
  const [{ getBlockWithTxs }, { syncingProvider }] = await Promise.all([
    import("../src/operations/blockOperations.js"),
    import("../src/providers.js"),
  ]);
  let attempts = 0;
  t.mock.method(syncingProvider, "getBlockWithTxs", async () => {
    attempts++;
    throw new Error("fetch failed");
  });

  await assert.rejects(
    getBlockWithTxs(syncingProvider, 42),
    /getBlockWithTxs\(42\) \[syncing\]: fetch failed/,
  );
  assert.equal(attempts, 1);
});
