import assert from "node:assert/strict";
import test from "node:test";
import { assertBlockVersionSupported } from "../src/blockVersionGuard.js";
import { StarknetRpcProfiles } from "../src/constants.js";

test("Starknet 0.14.1 replays over RPC v0.10 without proof facts", () => {
  assert.deepEqual(StarknetRpcProfiles["0.14.1"], {
    originalNodeRpcPath: "/rpc/v0_10",
    syncingNodeRpcPath: "/rpc/v0_10",
    supportsProofFacts: false,
  });
});

test("0.14.1 replay guard accepts the target era and rejects newer blocks", () => {
  assert.doesNotThrow(() =>
    assertBlockVersionSupported(1_486_025, "0.14.1", "0.14.1")
  );
  assert.throws(
    () => assertBlockVersionSupported(9_999_999, "0.14.2", "0.14.1"),
    /MAX_SUPPORTED_STARKNET_VERSION=0\.14\.1/
  );
});

test("version guard fails closed when a source block omits its version", () => {
  assert.throws(
    () => assertBlockVersionSupported(1_486_025, undefined, "0.14.1"),
    /does not expose starknet_version/
  );
});
