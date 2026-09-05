import assert from "node:assert/strict";
import test from "node:test";
import { resolveRpcUrl } from "../src/rpcUrl.js";

test("resolveRpcUrl appends version path for base RPC hosts", () => {
  assert.equal(
    resolveRpcUrl("https://rpc.starknet.lava.build", "/rpc/v0_10"),
    "https://rpc.starknet.lava.build/rpc/v0_10",
  );
});

test("resolveRpcUrl preserves full RPC endpoints", () => {
  assert.equal(
    resolveRpcUrl(
      "https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/example-key",
      "/rpc/v0_10",
    ),
    "https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/example-key",
  );
});
