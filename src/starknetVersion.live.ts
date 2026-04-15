import assert from "node:assert/strict";
import axios from "axios";
import {
  compareStarknetVersions,
  normalizeStarknetVersion,
} from "./starknetVersion.js";

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
  const rpcUrl = getLiveRpcUrl();
  const response = await axios.post<JsonRpcResponse<T>>(
    rpcUrl,
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

async function main(): Promise<void> {
  const rpcUrl = getLiveRpcUrl();
  const latestBlockNumber = await rpcCall<number>("starknet_blockNumber", []);
  const latestBlock = await rpcCall<BlockWithTxHashesResponse>(
    "starknet_getBlockWithTxHashes",
    [{ block_number: latestBlockNumber }],
  );

  assert.equal(
    latestBlock.block_number,
    latestBlockNumber,
    "latest block response did not match starknet_blockNumber",
  );
  assert.ok(
    latestBlock.starknet_version,
    "latest block did not include starknet_version",
  );

  const normalized = normalizeStarknetVersion(latestBlock.starknet_version);
  assert.equal(
    compareStarknetVersions(latestBlock.starknet_version, normalized),
    0,
    "live block version should compare equal to its normalized form",
  );

  console.log(
    [
      "Live Starknet version parser check passed",
      `rpc_url=${rpcUrl}`,
      `block_number=${latestBlockNumber}`,
      `starknet_version=${latestBlock.starknet_version}`,
      `normalized=${normalized}`,
    ].join(" "),
  );
}

await main();
