import { ReplayMode, ReplayModeType } from "./constants.js";

export function parseReplayMode(mode: string | undefined): ReplayModeType {
  if (!mode) {
    return ReplayMode.MANAGED_BLOCKS;
  }

  if (
    mode === ReplayMode.MANAGED_BLOCKS ||
    mode === ReplayMode.TRANSACTION_ONLY ||
    mode === ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION
  ) {
    return mode;
  }

  throw new Error(
    `Invalid REPLAY_MODE value: ${mode}. Expected ${ReplayMode.MANAGED_BLOCKS}, ${ReplayMode.TRANSACTION_ONLY}, or ${ReplayMode.TRANSACTION_ONLY_WITH_HASH_VALIDATION}.`,
  );
}

export function isBoundaryReplayMode(mode: ReplayModeType): boolean {
  return mode !== ReplayMode.MANAGED_BLOCKS;
}

export function shouldValidateBlockHash(mode: ReplayModeType): boolean {
  return mode !== ReplayMode.TRANSACTION_ONLY;
}
