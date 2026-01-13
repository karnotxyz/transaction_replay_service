import { RpcProvider } from "starknet";
import { config } from "./config.js";
import { RpcVersion, RpcVersionPaths, RpcVersionType } from "./constants.js";

type NodeType = "Original" | "Syncing";

/**
 * Create an RPC provider for a specific node and version
 */
function createProvider(node: NodeType, version: RpcVersionType): RpcProvider {
  const baseUrl =
    node === "Original" ? config.rpcUrlOriginalNode : config.rpcUrlSyncingNode;

  const nodeUrl = `${baseUrl}${RpcVersionPaths[version]}`;

  return new RpcProvider({
    nodeUrl,
    specVersion: version,
  });
}

// Original node providers
export const originalProvider_v8 = createProvider(
  "Original",
  RpcVersion.V0_8_1,
);
export const originalProvider_v9 = createProvider(
  "Original",
  RpcVersion.V0_9_0,
);

// Syncing node providers
export const syncingProvider_v8 = createProvider("Syncing", RpcVersion.V0_8_1);
export const syncingProvider_v9 = createProvider("Syncing", RpcVersion.V0_9_0);

/**
 * Get provider by version and node type
 */
export function getProvider(
  version: RpcVersionType,
  node: NodeType = "Syncing",
): RpcProvider {
  if (node === "Original") {
    return version === RpcVersion.V0_8_1
      ? originalProvider_v8
      : originalProvider_v9;
  } else {
    return version === RpcVersion.V0_8_1
      ? syncingProvider_v8
      : syncingProvider_v9;
  }
}

/**
 * Get a human-readable name for a provider (for logging)
 */
export function getNodeName(provider: RpcProvider): string {
  if (provider === originalProvider_v8 || provider === originalProvider_v9) {
    return "original";
  }
  if (provider === syncingProvider_v8 || provider === syncingProvider_v9) {
    return "syncing";
  }
  return "unknown";
}
