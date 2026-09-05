import { RpcProvider } from "starknet";
import { config } from "./config.js";
import {
  StarknetRpcProfiles,
  DEFAULT_RPC_PROFILE,
  StarknetRpcProfile,
} from "./constants.js";
import logger from "./logger.js";
import { resolveRpcUrl } from "./rpcUrl.js";

type NodeType = "Original" | "Syncing";

function resolveRpcProfile(): StarknetRpcProfile {
  const version = config.maxSupportedStarknetVersion;
  if (version && StarknetRpcProfiles[version]) {
    return StarknetRpcProfiles[version];
  }
  if (version) {
    logger.warn(
      `No RPC profile for Starknet version ${version}, falling back to default`,
    );
  }
  return DEFAULT_RPC_PROFILE;
}

const rpcProfile = resolveRpcProfile();
logger.info(
  `📡 RPC profile: original=${rpcProfile.originalNodeRpcPath}, syncing=${rpcProfile.syncingNodeRpcPath}, proofFacts=${rpcProfile.supportsProofFacts}`,
);

export function getOriginalUserRpcUrl(): string {
  return resolveRpcUrl(
    config.rpcUrlOriginalNode,
    rpcProfile.originalNodeRpcPath,
  );
}

export function getSyncingUserRpcUrl(): string {
  return resolveRpcUrl(
    config.rpcUrlSyncingNode,
    rpcProfile.syncingNodeRpcPath,
  );
}

export function supportsProofFacts(): boolean {
  return rpcProfile.supportsProofFacts;
}

function createProvider(nodeUrl: string): RpcProvider {
  return new RpcProvider({ nodeUrl });
}

export const originalProvider = createProvider(getOriginalUserRpcUrl());
export const syncingProvider = createProvider(getSyncingUserRpcUrl());

export function getNodeName(provider: RpcProvider): string {
  if (provider === originalProvider) {
    return "original";
  }
  if (provider === syncingProvider) {
    return "syncing";
  }
  return "unknown";
}
