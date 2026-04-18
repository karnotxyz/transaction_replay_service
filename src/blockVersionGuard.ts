import logger from "./logger.js";
import { incrementErrors } from "./telemetry/metrics.js";
import { UnsupportedStarknetVersionError } from "./errors/index.js";
import { compareStarknetVersions } from "./starknetVersion.js";

export function assertBlockVersionSupported(
  blockNumber: number,
  blockVersion: string | undefined,
  maxSupportedVersion: string,
): void {
  if (!blockVersion) {
    incrementErrors(
      "unsupported_starknet_version",
      "assertSupportedBlockVersion",
    );
    logger.error(
      `Block ${blockNumber} does not expose starknet_version while MAX_SUPPORTED_STARKNET_VERSION=${maxSupportedVersion} is configured`,
    );
    throw new UnsupportedStarknetVersionError(
      blockNumber,
      null,
      maxSupportedVersion,
    );
  }

  if (compareStarknetVersions(blockVersion, maxSupportedVersion) > 0) {
    incrementErrors(
      "unsupported_starknet_version",
      "assertSupportedBlockVersion",
    );
    logger.error(
      `Block ${blockNumber} uses Starknet version ${blockVersion}, which exceeds MAX_SUPPORTED_STARKNET_VERSION=${maxSupportedVersion}`,
    );
    throw new UnsupportedStarknetVersionError(
      blockNumber,
      blockVersion,
      maxSupportedVersion,
    );
  }
}
