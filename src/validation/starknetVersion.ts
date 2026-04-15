import { config } from "../config.js";
import { UnsupportedStarknetVersionError } from "../errors/index.js";
import { compareStarknetVersions } from "../starknetVersion.js";

export function assertSupportedBlockVersion(
  blockNumber: number,
  starknetVersion?: string,
): void {
  const maxSupportedVersion = config.maxSupportedStarknetVersion;

  if (!maxSupportedVersion) {
    return;
  }

  if (!starknetVersion) {
    throw new UnsupportedStarknetVersionError(
      blockNumber,
      null,
      maxSupportedVersion,
    );
  }

  if (
    compareStarknetVersions(starknetVersion, maxSupportedVersion) > 0
  ) {
    throw new UnsupportedStarknetVersionError(
      blockNumber,
      starknetVersion,
      maxSupportedVersion,
    );
  }
}
