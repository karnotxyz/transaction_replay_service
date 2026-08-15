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
const secondBalancePrerequisite =
  "0x2a2aca6e81fc72999763ad388cfd4f3c257b5f3e336d865479590e438244b9b";
const secondBalanceUpdate =
  "0x170cc18cdc09097f55b0b2d619ff298d97dce48188cc3c115ce1adecb4313d1";
const secondWithdrawal =
  "0x462eb7ca68773442217fba696e34953000945cc2d432abdf1c2767d0ca9bd99";

test("holds benchmark transactions for their exact dependencies in mempool mode", () => {
  assert.equal(
    getBenchmarkMempoolDependency(withdrawal, "mempool"),
    balanceUpdate,
  );
  assert.equal(
    getBenchmarkMempoolDependency(secondBalanceUpdate, "mempool"),
    secondBalancePrerequisite,
  );
  assert.equal(
    getBenchmarkMempoolDependency(secondWithdrawal, "mempool"),
    secondBalanceUpdate,
  );
  assert.equal(getBenchmarkMempoolDependency("0x123", "mempool"), undefined);
  assert.equal(
    getBenchmarkMempoolDependency(withdrawal, "bypass"),
    undefined,
  );
});
