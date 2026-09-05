function parseStarknetVersion(version: string): number[] {
  const normalized = version.trim().replace(/^v/i, "");
  const [coreVersion] = normalized.split("-");

  if (!coreVersion || !/^\d+(?:\.\d+)*$/.test(coreVersion)) {
    throw new Error(`Invalid Starknet version: ${version}`);
  }

  return coreVersion.split(".").map((part) => Number.parseInt(part, 10));
}

export function normalizeStarknetVersion(version: string): string {
  return parseStarknetVersion(version).join(".");
}

export function compareStarknetVersions(
  leftVersion: string,
  rightVersion: string,
): number {
  const leftParts = parseStarknetVersion(leftVersion);
  const rightParts = parseStarknetVersion(rightVersion);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index++) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;

    if (leftPart > rightPart) {
      return 1;
    }

    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}
