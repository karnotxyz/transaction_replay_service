import { config } from "../config.js";
import { assertBlockVersionSupported } from "../blockVersionGuard.js";

export function assertSupportedBlockVersion(
  blockNumber: number,
  starknetVersion?: string,
): void {
  const maxSupportedVersion = config.maxSupportedStarknetVersion;

  if (!maxSupportedVersion) {
    return;
  }

  assertBlockVersionSupported(
    blockNumber,
    starknetVersion,
    maxSupportedVersion,
  );
}
