import assert from "node:assert/strict";
import axios from "axios";
import { assertBlockVersionSupported } from "../src/blockVersionGuard.js";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: JsonRpcError;
}

interface BlockWithTxHashesResponse {
  block_number: number;
  starknet_version?: string;
}

function getLiveRpcUrl(): string {
  return (
    process.env.LIVE_STARKNET_RPC_URL ||
    "https://pathfinder-sepolia.d.karnot.xyz"
  ).replace(/\/$/, "");
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const response = await axios.post<JsonRpcResponse<T>>(
    getLiveRpcUrl(),
    {
      jsonrpc: "2.0",
      method,
      params,
      id: 1,
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 15_000,
    },
  );

  if (response.data.error) {
    throw new Error(
      `${method} failed: ${response.data.error.message} (code ${response.data.error.code})`,
    );
  }

  if (response.data.result === undefined) {
    throw new Error(`${method} returned no result`);
  }

  return response.data.result;
}

async function getBlockVersion(
  blockNumber: number,
): Promise<BlockWithTxHashesResponse> {
  return rpcCall<BlockWithTxHashesResponse>("starknet_getBlockWithTxHashes", [
    { block_number: blockNumber },
  ]);
}

async function main(): Promise<void> {
  const beforeUpgradeBlock = 7984519;
  const firstUpgradeBlock = 7984520;

  const beforeUpgrade = await getBlockVersion(beforeUpgradeBlock);
  const afterUpgrade = await getBlockVersion(firstUpgradeBlock);

  assert.equal(beforeUpgrade.starknet_version, "0.14.1");
  assert.equal(afterUpgrade.starknet_version, "0.14.2");

  assert.doesNotThrow(() =>
    assertBlockVersionSupported(
      beforeUpgrade.block_number,
      beforeUpgrade.starknet_version,
      "0.14.1",
    ),
  );

  assert.throws(
    () =>
      assertBlockVersionSupported(
        afterUpgrade.block_number,
        afterUpgrade.starknet_version,
        "0.14.1",
      ),
    /MAX_SUPPORTED_STARKNET_VERSION=0\.14\.1/,
  );

  assert.doesNotThrow(() =>
    assertBlockVersionSupported(
      afterUpgrade.block_number,
      afterUpgrade.starknet_version,
      "0.14.2",
    ),
  );

  console.log(
    [
      "Live Starknet version boundary check passed",
      `rpc_url=${getLiveRpcUrl()}`,
      `before_upgrade_block=${beforeUpgrade.block_number}`,
      `before_upgrade_version=${beforeUpgrade.starknet_version}`,
      `first_upgrade_block=${afterUpgrade.block_number}`,
      `first_upgrade_version=${afterUpgrade.starknet_version}`,
      "max_0.14.1=rejects_0.14.2",
      "max_0.14.2=accepts_0.14.2",
    ].join(" "),
  );
}

await main();
