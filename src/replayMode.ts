import { ReplayMode, ReplayModeType } from "./constants.js";

export function parseReplayMode(mode: string | undefined): ReplayModeType {
  if (!mode) {
    return ReplayMode.MANAGED_BLOCKS;
  }

  if (
    mode === ReplayMode.MANAGED_BLOCKS ||
    mode === ReplayMode.TRANSACTION_ONLY ||
    mode === ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION ||
    mode === ReplayMode.MEMPOOL
  ) {
    return mode;
  }

  throw new Error(
    `Invalid REPLAY_MODE value: ${mode}. Expected ${ReplayMode.MANAGED_BLOCKS}, ${ReplayMode.TRANSACTION_ONLY}, ${ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION}, or ${ReplayMode.MEMPOOL}.`,
  );
}

export function isTransactionReplayMode(mode: ReplayModeType): boolean {
  return mode !== ReplayMode.MANAGED_BLOCKS;
}

export function usesReplayBoundaries(mode: ReplayModeType): boolean {
  return (
    mode === ReplayMode.TRANSACTION_ONLY ||
    mode === ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION
  );
}

export function isMempoolReplayMode(mode: ReplayModeType): boolean {
  return mode === ReplayMode.MEMPOOL;
}

export function shouldValidateBlockHash(mode: ReplayModeType): boolean {
  return (
    mode === ReplayMode.MANAGED_BLOCKS ||
    mode === ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION
  );
}
