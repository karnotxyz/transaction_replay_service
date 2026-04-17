import { UnsupportedStarknetVersionError } from "./errors/index.js";
import { compareStarknetVersions } from "./starknetVersion.js";

export function assertBlockVersionSupported(
  blockNumber: number,
  blockVersion: string | undefined,
  maxSupportedVersion: string,
): void {
  if (!blockVersion) {
    throw new UnsupportedStarknetVersionError(
      blockNumber,
      null,
      maxSupportedVersion,
    );
  }

  if (compareStarknetVersions(blockVersion, maxSupportedVersion) > 0) {
    throw new UnsupportedStarknetVersionError(
      blockNumber,
      blockVersion,
      maxSupportedVersion,
    );
  }
}
