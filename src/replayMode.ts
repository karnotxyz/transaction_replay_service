import { ReplayMode, ReplayModeType } from "./constants.js";

export function parseReplayMode(mode: string | undefined): ReplayModeType {
  if (!mode) {
    return ReplayMode.MANAGED_BLOCKS;
  }

  if (mode === ReplayMode.MANAGED_BLOCKS || mode === ReplayMode.TRANSACTION_ONLY) {
    return mode;
  }

  throw new Error(
    `Invalid REPLAY_MODE value: ${mode}. Expected ${ReplayMode.MANAGED_BLOCKS} or ${ReplayMode.TRANSACTION_ONLY}.`,
  );
}
