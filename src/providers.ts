import { RpcProvider } from "starknet";
import { config } from "./config.js";
import { RpcVersion, RpcVersionPaths } from "./constants.js";

type NodeType = "Original" | "Syncing";

function joinRpcUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export function getOriginalUserRpcUrl(): string {
  return joinRpcUrl(config.rpcUrlOriginalNode, RpcVersionPaths[RpcVersion.V0_10]);
}

export function getSyncingUserRpcUrl(): string {
  return joinRpcUrl(config.rpcUrlSyncingNode, RpcVersionPaths[RpcVersion.V0_10_2]);
}

/**
 * Create an RPC provider for a specific node URL
 */
function createProvider(_node: NodeType, nodeUrl: string): RpcProvider {
  return new RpcProvider({
    nodeUrl,
  });
}

export const originalProvider_v9 = createProvider(
  "Original",
  getOriginalUserRpcUrl(),
);

export const syncingProvider_v9 = createProvider(
  "Syncing",
  getSyncingUserRpcUrl(),
);

/**
 * Get provider by version and node type
 */
export function getProvider(
  _version: typeof RpcVersion.V0_9_0,
  node: NodeType = "Syncing",
): RpcProvider {
  if (node === "Original") {
    return originalProvider_v9;
  } else {
    return syncingProvider_v9;
  }
}

/**
 * Get a human-readable name for a provider (for logging)
 */
export function getNodeName(provider: RpcProvider): string {
  if (provider === originalProvider_v9) {
    return "original";
  }
  if (provider === syncingProvider_v9) {
    return "syncing";
  }
  return "unknown";
}
