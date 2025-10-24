import { RpcProvider } from "starknet";
import dotenv from "dotenv";
dotenv.config();

const baseOriginalUrl = process.env.RPC_URL_ORIGINAL_NODE!;
const baseSyncingUrl = process.env.RPC_URL_SYNCING_NODE!;

type RpcVersion = "0.8.1" | "0.9.0";
type NodeType = "Original" | "Syncing";

const versionMap: Record<RpcVersion, string> = {
  // "0.7.1": "/rpc/v0_7_1", # Not supported by latest starknet version
  "0.8.1": "/rpc/v0_8_1",
  "0.9.0": "/rpc/v0_9",
};

function createProvider(node: NodeType, version: RpcVersion): RpcProvider {
  const baseUrl = node === "Original" ? baseOriginalUrl : baseSyncingUrl;

  return new RpcProvider({
    nodeUrl: `${baseUrl}${versionMap[version]}`,
    specVersion: version,
  });
}

// const originalProvider_v7 = createProvider("Original", "0.7.1");
const originalProvider_v8 = createProvider("Original", "0.8.1");
const originalProvider_v9 = createProvider("Original", "0.9.0");

// const syncingProvider_v7 = createProvider("Syncing", "0.7.1");
const syncingProvider_v8 = createProvider("Syncing", "0.8.1");
const syncingProvider_v9 = createProvider("Syncing", "0.9.0");

export {
  originalProvider_v9,
  originalProvider_v8,
  syncingProvider_v9,
  syncingProvider_v8,
};
