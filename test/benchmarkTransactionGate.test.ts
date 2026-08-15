import assert from "node:assert/strict";
import test from "node:test";

process.env.RPC_URL_ORIGINAL_NODE ??= "http://original.example";
process.env.RPC_URL_SYNCING_NODE ??= "http://syncing.example";
process.env.ADMIN_RPC_URL_SYNCING_NODE ??= "http://admin.example";

const { getBenchmarkMempoolDependency } = await import(
  "../src/sync/TransactionProcessor.js"
);

const withdrawal =
  "0x3f55308078a6bc808447c77909ebb062416de42acb3ea31a466532a80976845";
const balanceUpdate =
  "0x663482430fb4490128452304d1ec257ec23cb98d0aecf742ade1073c1c7630f";

test("holds only the benchmark withdrawal in mempool mode", () => {
  assert.equal(
    getBenchmarkMempoolDependency(withdrawal, "mempool"),
    balanceUpdate,
  );
  assert.equal(getBenchmarkMempoolDependency("0x123", "mempool"), undefined);
  assert.equal(
    getBenchmarkMempoolDependency(withdrawal, "bypass"),
    undefined,
  );
});
