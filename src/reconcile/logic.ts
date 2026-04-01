import { ReconcileConfig } from "../constants.js";

export interface BlockSnapshot {
  blockNumber: number;
  blockHash: string | null;
  txCount: number;
}

export interface BlockComparison {
  blockNumber: number;
  local: BlockSnapshot;
  source: BlockSnapshot;
  hashMatches: boolean;
  txCountMatches: boolean;
  matches: boolean;
}

export interface ScanPlan {
  rangeStart: number;
  rangeEnd: number;
  depth: number;
}

export interface BoundaryScanResult {
  status: "healthy" | "repairable" | "unrecoverable";
  comparisons: BlockComparison[];
  firstBad?: BlockComparison;
  lastGood?: BlockComparison;
  deeperCandidate?: BlockComparison;
}

export function buildScanPlan(
  anchorBlock: number,
  depth: number = ReconcileConfig.SCAN_DEPTHS[0],
): ScanPlan {
  const rangeStart = Math.max(0, anchorBlock - depth + 1);

  return {
    rangeStart,
    rangeEnd: anchorBlock,
    depth,
  };
}

export function compareBlocks(
  local: BlockSnapshot,
  source: BlockSnapshot,
): BlockComparison {
  const hashMatches = local.blockHash === source.blockHash;
  const txCountMatches = local.txCount === source.txCount;

  return {
    blockNumber: local.blockNumber,
    local,
    source,
    hashMatches,
    txCountMatches,
    matches: hashMatches && txCountMatches,
  };
}

export function evaluateBoundaryWindow(
  comparisons: BlockComparison[],
): BoundaryScanResult {
  const firstBadIndex = comparisons.findIndex((comparison) => !comparison.matches);

  if (firstBadIndex === -1) {
    return {
      status: "healthy",
      comparisons,
    };
  }

  if (firstBadIndex === 0) {
    return {
      status: "unrecoverable",
      comparisons,
      firstBad: comparisons[0],
    };
  }

  return {
    status: "repairable",
    comparisons,
    firstBad: comparisons[firstBadIndex],
    lastGood: comparisons[firstBadIndex - 1],
    deeperCandidate:
      firstBadIndex - 2 >= 0 ? comparisons[firstBadIndex - 2] : undefined,
  };
}

export function findResumeBlock(
  scanResult: BoundaryScanResult,
  localHead: number,
): number {
  if (scanResult.status === "repairable" && scanResult.lastGood) {
    return scanResult.lastGood.blockNumber + 1;
  }

  return localHead + 1;
}
