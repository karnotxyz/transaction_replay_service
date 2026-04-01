import { BlockIdentifier } from "starknet";
import logger from "../logger.js";
import { persistence } from "../persistence.js";
import { syncStateManager } from "../state/index.js";
import {
  getLatestBlockNumber,
  getBlockWithTxHashes,
  revertToAndShutdown,
} from "../operations/blockOperations.js";
import { originalProvider_v9, syncingProvider_v9 } from "../providers.js";
import { waitForMadaraRecovery } from "../madara/index.js";
import { ReconcileConfig } from "../constants.js";
import { SyncState } from "../types.js";
import {
  BlockComparison,
  BlockSnapshot,
  BoundaryScanResult,
  buildScanPlan,
  compareBlocks,
  evaluateBoundaryWindow,
} from "./logic.js";

export interface ReconcileResult {
  status: "healthy" | "repaired" | "deferred" | "failed" | "skipped";
  localHead: number;
  resumeFrom?: number;
  lastGoodBlock?: number;
  firstBadBlock?: number;
  error?: string;
}

interface ReconcileOptions {
  trigger: string;
  anchorBlock?: number;
  inline?: boolean;
  skipIfRunning?: boolean;
  allowHardRetry?: boolean;
  autoRestartIfIntended?: boolean;
}

interface SyncStarterOptions {
  startBlock?: number;
  skipReconcile?: boolean;
}

type SyncStarter = (
  endBlock: BlockIdentifier,
  options?: SyncStarterOptions,
) => Promise<any>;

export interface ReconcileOps {
  getLocalHead(): Promise<number>;
  getLocalBlock(blockNumber: number): Promise<any>;
  getSourceBlock(blockNumber: number): Promise<any>;
  revertToAndShutdown(blockHash: string): Promise<void>;
  waitForMadaraRecovery(): Promise<boolean>;
}

export interface ReconcileStateStore {
  readState(): SyncState | null;
  shouldAutoResumeOnStartup(): boolean;
  patchState(patch: Partial<SyncState>): SyncState | null;
  markReconciling(resumeAfterReconcile: boolean): void;
  markReconcileFailed(resumeAfterReconcile: boolean): void;
  restoreIdleAfterReconcile(): void;
  getIntendedTarget(): {
    syncTo: number | "latest" | null;
    isContinuous: boolean;
    resumeAfterReconcile: boolean;
    status: SyncState["status"];
  } | null;
}

export interface ReconcileSyncController {
  hasActiveProcess(): boolean;
  requestReconcileStop(): boolean;
  waitForRunToFinish(): Promise<void>;
}

interface ScanWindowResult {
  localHead: number;
  scan: BoundaryScanResult;
}

const defaultOps: ReconcileOps = {
  getLocalHead: () => getLatestBlockNumber(syncingProvider_v9),
  getLocalBlock: (blockNumber: number) =>
    getBlockWithTxHashes(syncingProvider_v9, blockNumber),
  getSourceBlock: (blockNumber: number) =>
    getBlockWithTxHashes(originalProvider_v9, blockNumber),
  revertToAndShutdown,
  waitForMadaraRecovery: () =>
    waitForMadaraRecovery({
      requireObservedDown: true,
      minHealthyChecks: 2,
    }),
};

const defaultStateStore: ReconcileStateStore = {
  readState: () => persistence.readState(),
  shouldAutoResumeOnStartup: () => persistence.shouldAutoResumeOnStartup(),
  patchState: (patch: Partial<SyncState>) => persistence.patchState(patch),
  markReconciling: (resumeAfterReconcile: boolean) =>
    persistence.markReconciling(resumeAfterReconcile),
  markReconcileFailed: (resumeAfterReconcile: boolean) =>
    persistence.markReconcileFailed(resumeAfterReconcile),
  restoreIdleAfterReconcile: () => persistence.restoreIdleAfterReconcile(),
  getIntendedTarget: () => persistence.getIntendedTarget(),
};

const defaultSyncController: ReconcileSyncController = {
  hasActiveProcess: () => syncStateManager.hasActiveProcess(),
  requestReconcileStop: () => syncStateManager.requestReconcileStop(),
  waitForRunToFinish: () => syncStateManager.waitForRunToFinish(),
};

export class ReconcileManager {
  private readonly intervalMs: number;
  private readonly ops: ReconcileOps;
  private readonly stateStore: ReconcileStateStore;
  private readonly syncController: ReconcileSyncController;
  private interval: NodeJS.Timeout | null = null;
  private inFlight: Promise<ReconcileResult> | null = null;
  private startSyncHandler: SyncStarter | null = null;

  constructor(
    intervalMs: number = ReconcileConfig.INTERVAL_MS,
    ops: ReconcileOps = defaultOps,
    stateStore: ReconcileStateStore = defaultStateStore,
    syncController: ReconcileSyncController = defaultSyncController,
  ) {
    this.intervalMs = intervalMs;
    this.ops = ops;
    this.stateStore = stateStore;
    this.syncController = syncController;
  }

  public registerStartSyncHandler(handler: SyncStarter): void {
    this.startSyncHandler = handler;
  }

  public start(): void {
    if (this.interval) {
      return;
    }

    logger.info(
      `🩺 Starting reconcile loop (checks every ${this.intervalMs / 1000}s)`,
    );

    this.interval = setInterval(() => {
      this.ensureHealthyHead({
        trigger: "scheduled",
        skipIfRunning: true,
      }).catch((error) => {
        logger.error("❌ Scheduled reconcile loop failed:", error);
      });
    }, this.intervalMs);
  }

  public stop(): void {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;
    logger.info("🛑 Reconcile loop stopped");
  }

  public async recoverOnStartup(): Promise<void> {
    const state = this.stateStore.readState();

    if (!state) {
      logger.info("✅ No state file found - waiting for RPC call to start sync");
      return;
    }

    const shouldBootstrapLatest = this.shouldBootstrapLatest(state);

    if (!this.stateStore.shouldAutoResumeOnStartup() && !shouldBootstrapLatest) {
      logger.info(
        `✅ State file shows status="${state.status}" - waiting for RPC call to start sync`,
      );
      return;
    }

    if (shouldBootstrapLatest) {
      logger.info(
        "🔍 Startup reconcile: recovered idle lane detected, validating head before bootstrapping latest sync...",
      );
    } else {
      logger.info(
        "🔍 Startup reconcile: validating confirmed head before resume...",
      );
    }

    const outcome = await this.ensureHealthyHead({
      trigger: "startup",
      anchorBlock: state.currentBlock ?? undefined,
      allowHardRetry: true,
    });

    if (outcome.status === "failed") {
      logger.error("❌ Startup reconcile failed:", outcome.error);
      return;
    }

    if (outcome.status === "deferred") {
      logger.warn(
        `⚠️ Startup reconcile deferred: ${outcome.error}. Service will retry on the scheduled loop.`,
      );
    }
  }

  public async ensureHealthyBeforeSync(): Promise<ReconcileResult> {
    return this.ensureHealthyHead({
      trigger: "pre-start",
      allowHardRetry: true,
      autoRestartIfIntended: false,
    });
  }

  public async handleRuntimeFault(anchorBlock: number): Promise<ReconcileResult> {
    return this.ensureHealthyHead({
      trigger: "runtime-fault",
      anchorBlock,
      inline: true,
      allowHardRetry: true,
      autoRestartIfIntended: false,
    });
  }

  public async ensureHealthyHead(
    options: ReconcileOptions,
  ): Promise<ReconcileResult> {
    if (this.inFlight) {
      if (options.skipIfRunning) {
        logger.info(
          `⏭️ Reconcile already running - skipping ${options.trigger} tick`,
        );
        return {
          status: "skipped",
          localHead: -1,
        };
      }

      return this.inFlight;
    }

    const runPromise = this.runReconcile(options).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = runPromise;
    return runPromise;
  }

  private async runReconcile(options: ReconcileOptions): Promise<ReconcileResult> {
    const state = this.stateStore.readState();

    logger.info(`🩺 Reconcile started [trigger=${options.trigger}]`);

    const shouldResumeAfterRepair = this.shouldResumeAfterRepair(state, options);
    const fallbackEndBlock = this.getFallbackRestartTarget(state);
    const scanResult = await this.scanHead(options.anchorBlock);

    if ("error" in scanResult) {
      if (!options.inline && !this.syncController.hasActiveProcess()) {
        this.stateStore.markReconciling(shouldResumeAfterRepair);
      } else if (options.inline) {
        this.stateStore.markReconciling(shouldResumeAfterRepair);
      }

      return {
        status: scanResult.status,
        localHead: scanResult.localHead,
        error: scanResult.error,
      };
    }

    const { localHead, scan } = scanResult;

    if (scan.status === "healthy") {
      const result: ReconcileResult = {
        status: "healthy",
        localHead,
        resumeFrom: localHead + 1,
      };

      if (options.inline) {
        this.clearFailureStreak();
      }

      if (!options.inline) {
        await this.finishServiceReconcile(
          result,
          shouldResumeAfterRepair,
          options.autoRestartIfIntended !== false,
          fallbackEndBlock,
        );
      }

      logger.info(`✅ Reconcile found a sane confirmed head at ${localHead}`);
      return result;
    }

    if (scan.status === "unrecoverable" || !scan.lastGood || !scan.firstBad) {
      const result: ReconcileResult = {
        status: "failed",
        localHead,
        error: "Could not identify a last good block inside the scan window",
        firstBadBlock: scan.firstBad?.blockNumber,
      };

      if (options.inline) {
        this.persistFailedReconcileResult(result, shouldResumeAfterRepair);
      }

      return {
        ...result,
      };
    }

    if (!options.inline) {
      this.stateStore.markReconciling(shouldResumeAfterRepair);
      await this.stopActiveSyncIfNeeded();
    }

    const repairResult = await this.repairDirtyHead(
      scan,
      shouldResumeAfterRepair,
      options,
    );

    if (!options.inline) {
      await this.finishServiceReconcile(
        repairResult,
        shouldResumeAfterRepair,
        options.autoRestartIfIntended !== false,
        fallbackEndBlock,
      );
    } else if (repairResult.status === "failed") {
      this.persistFailedReconcileResult(repairResult, shouldResumeAfterRepair);
    } else if (repairResult.status === "deferred") {
      this.stateStore.markReconciling(shouldResumeAfterRepair);
    }

    return repairResult;
  }

  private shouldResumeAfterRepair(
    state: SyncState | null,
    options: ReconcileOptions,
  ): boolean {
    if (options.inline) {
      return true;
    }

    if (this.syncController.hasActiveProcess()) {
      return true;
    }

    if (!state) {
      return false;
    }

    if (state.status === "running") {
      return true;
    }

    if (state.status === "reconcile_failed") {
      return true;
    }

    if (this.shouldBootstrapLatest(state)) {
      return true;
    }

    return state.status === "reconciling" && state.resumeAfterReconcile;
  }

  private clearFailureStreak(): void {
    this.stateStore.patchState({
      reconcileFailureBlock: null,
      reconcileFailureCount: 0,
    });
  }

  private persistFailedReconcileResult(
    result: ReconcileResult,
    shouldResumeAfterRepair: boolean,
  ): void {
    if (result.firstBadBlock !== undefined) {
      this.recordBlockFailure(result.firstBadBlock, shouldResumeAfterRepair);
      return;
    }

    this.stateStore.markReconciling(shouldResumeAfterRepair);
  }

  private recordBlockFailure(
    blockNumber: number,
    shouldResumeAfterRepair: boolean,
  ): void {
    const state = this.stateStore.readState();
    const nextCount =
      state?.reconcileFailureBlock === blockNumber
        ? state.reconcileFailureCount + 1
        : 1;
    const reachedLimit =
      nextCount >= ReconcileConfig.MAX_SAME_BLOCK_FAILURES;

    this.stateStore.patchState({
      status: reachedLimit ? "reconcile_failed" : "reconciling",
      resumeAfterReconcile: reachedLimit ? false : shouldResumeAfterRepair,
      reconcileFailureBlock: blockNumber,
      reconcileFailureCount: nextCount,
    });

    if (reachedLimit) {
      logger.error(
        `🛑 Reconcile hit the same bad block ${blockNumber} ${nextCount} times in a row - stopping automatic sync continuation`,
      );
      return;
    }

    logger.warn(
      `🔁 Reconcile failed on block ${blockNumber} (${nextCount}/${ReconcileConfig.MAX_SAME_BLOCK_FAILURES}); will retry on the next scheduled loop`,
    );
  }

  private shouldBootstrapLatest(state: SyncState | null): boolean {
    if (!state) {
      return false;
    }

    return (
      state.status === "idle" &&
      state.syncTo === null &&
      state.currentBlock !== null &&
      state.lastVerifiedBlock !== null
    );
  }

  private getFallbackRestartTarget(
    state: SyncState | null,
  ): number | "latest" | null {
    if (!state) {
      return null;
    }

    if (state.status === "reconcile_failed") {
      return "latest";
    }

    if (this.shouldBootstrapLatest(state)) {
      return "latest";
    }

    return null;
  }

  private async stopActiveSyncIfNeeded(): Promise<void> {
    if (!this.syncController.hasActiveProcess()) {
      return;
    }

    this.syncController.requestReconcileStop();
    await this.syncController.waitForRunToFinish();
  }

  private async scanHead(anchorBlock?: number): Promise<
    | ScanWindowResult
    | {
      status: "deferred" | "failed";
      localHead: number;
      error: string;
      hardFailure: boolean;
    }
  > {
    let localHead: number;
    try {
      localHead = await this.ops.getLocalHead();
    } catch (error) {
      return {
        status: "deferred",
        localHead: -1,
        error: `Unable to read syncing node head: ${this.formatError(error)}`,
        hardFailure: false,
      };
    }

    const anchor = Math.max(0, localHead);
    const maxDepth = Math.min(ReconcileConfig.MAX_SCAN_DEPTH, anchor + 1);
    const scanDepths = Array.from(
      new Set(
        ReconcileConfig.SCAN_DEPTHS.map((depth) => Math.min(depth, maxDepth)),
      ),
    );
    const scanPlans = scanDepths.map((depth) => buildScanPlan(anchor, depth));

    for (const plan of scanPlans) {
      const comparisons = await this.fetchComparisons(
        plan.rangeStart,
        plan.rangeEnd,
      );

      if ("error" in comparisons) {
        return {
          status: comparisons.status,
          localHead,
          error: comparisons.error,
          hardFailure: comparisons.hardFailure,
        };
      }

      const scan = evaluateBoundaryWindow(comparisons);
      const hasMoreDepth = plan.depth < maxDepth;
      const needsExtendedRetryContext =
        scan.status === "repairable" &&
        !scan.deeperCandidate &&
        hasMoreDepth &&
        (scan.lastGood?.blockNumber ?? 0) > 0;

      if (needsExtendedRetryContext) {
        continue;
      }

      if (scan.status !== "unrecoverable" || !hasMoreDepth) {
        return { localHead, scan };
      }
    }

    return {
      status: "failed",
      localHead,
      error: "Could not scan the head boundary",
      hardFailure: true,
    };
  }

  private async fetchComparisons(
    rangeStart: number,
    rangeEnd: number,
  ): Promise<
    | BlockComparison[]
    | { status: "deferred" | "failed"; error: string; hardFailure: boolean }
  > {
    const comparisons: BlockComparison[] = [];

    for (let blockNumber = rangeStart; blockNumber <= rangeEnd; blockNumber++) {
      const [localResult, sourceResult] = await Promise.allSettled([
        this.ops.getLocalBlock(blockNumber),
        this.ops.getSourceBlock(blockNumber),
      ]);

      if (localResult.status === "rejected") {
        return {
          status: "deferred",
          error: `Unable to read local block ${blockNumber}: ${this.formatError(localResult.reason)}`,
          hardFailure: false,
        };
      }

      if (sourceResult.status === "rejected") {
        return {
          status: "deferred",
          error: `Unable to read source block ${blockNumber}: ${this.formatError(sourceResult.reason)}`,
          hardFailure: false,
        };
      }

      comparisons.push(
        compareBlocks(
          this.toBlockSnapshot(blockNumber, localResult.value),
          this.toBlockSnapshot(blockNumber, sourceResult.value),
        ),
      );
    }

    return comparisons;
  }

  private toBlockSnapshot(blockNumber: number, block: any): BlockSnapshot {
    return {
      blockNumber,
      blockHash: "block_hash" in block ? block.block_hash : null,
      txCount: Array.isArray(block.transactions) ? block.transactions.length : 0,
    };
  }

  private async repairDirtyHead(
    scan: BoundaryScanResult,
    shouldResumeAfterRepair: boolean,
    options: ReconcileOptions,
  ): Promise<ReconcileResult> {
    let targetGood = scan.lastGood!;
    let deeperCandidate = scan.deeperCandidate;
    let deeperRetryUsed = false;

    while (true) {
      const targetHash = targetGood.source.blockHash;
      if (!targetHash) {
        return {
          status: "failed",
          localHead: targetGood.blockNumber,
          error: `Last good block ${targetGood.blockNumber} has no source hash`,
        };
      }

      logger.warn(
        `↩️ Reconcile repairing head: firstBad=${scan.firstBad!.blockNumber}, lastGood=${targetGood.blockNumber}`,
      );

      try {
        await this.ops.revertToAndShutdown(targetHash);
      } catch (error) {
        return {
          status: "failed",
          localHead: targetGood.blockNumber,
          error: `Revert failed: ${this.formatError(error)}`,
        };
      }

      const recovered = await this.ops.waitForMadaraRecovery();
      if (!recovered) {
        return {
          status: "failed",
          localHead: targetGood.blockNumber,
          error: "Madara did not recover after revert",
        };
      }

      const verification = await this.verifyRepair(targetGood, scan.firstBad!);
      if (verification.status === "deferred") {
        logger.warn(
          `⚠️ Reconcile verification deferred after revert to ${targetGood.blockNumber}: ${verification.error}`,
        );
        return verification;
      }

      if (verification.status === "healthy") {
        const result: ReconcileResult = {
          status: "repaired",
          localHead: verification.localHead,
          resumeFrom: targetGood.blockNumber + 1,
          lastGoodBlock: targetGood.blockNumber,
          firstBadBlock: scan.firstBad!.blockNumber,
        };

        this.stateStore.patchState({
          currentBlock: result.resumeFrom ?? verification.localHead + 1,
          lastVerifiedBlock: targetGood.blockNumber,
          lastVerifiedHash: targetHash,
          status: options.inline ? "running" : "reconciling",
          resumeAfterReconcile: shouldResumeAfterRepair,
        });

        logger.info(
          `✅ Reconcile repaired dirty head. Resume from block ${result.resumeFrom}`,
        );

        if (options.inline) {
          this.clearFailureStreak();
        }

        return result;
      }

      logger.warn(
        `⚠️ Reconcile verification failed after revert to ${targetGood.blockNumber}: ${verification.error}`,
      );

      if (!deeperRetryUsed && deeperCandidate?.source.blockHash) {
        logger.warn(
          `⚠️ First bad block ${scan.firstBad!.blockNumber} still present after repair; retrying one block deeper`,
        );
        deeperRetryUsed = true;
        targetGood = deeperCandidate;
        deeperCandidate = undefined;
        continue;
      }

      return {
        status: "failed",
        localHead: verification.localHead,
        error:
          "Dirty confirmed head persisted after the allowed repair attempts",
        lastGoodBlock: targetGood.blockNumber,
        firstBadBlock: scan.firstBad!.blockNumber,
      };
    }
  }

  private async verifyRepair(
    lastGood: BlockComparison,
    firstBad: BlockComparison,
  ): Promise<
    | { status: "healthy"; localHead: number }
    | { status: "deferred"; localHead: number; error: string }
    | { status: "failed"; localHead: number; error: string }
  > {
    let localHead: number;
    try {
      localHead = await this.ops.getLocalHead();
    } catch (error) {
      return {
        status: "deferred",
        localHead: -1,
        error: `Unable to read local head after revert: ${this.formatError(error)}`,
      };
    }

    const lastGoodCheck = await this.fetchComparisons(
      lastGood.blockNumber,
      lastGood.blockNumber,
    );
    if ("error" in lastGoodCheck) {
      return {
        status: lastGoodCheck.status,
        localHead,
        error: lastGoodCheck.error,
      };
    }

    if (!lastGoodCheck[0].matches) {
      return {
        status: "failed",
        localHead,
        error: `Last good block ${lastGood.blockNumber} did not match source after revert`,
      };
    }

    if (localHead >= firstBad.blockNumber) {
      const firstBadCheck = await this.fetchComparisons(
        firstBad.blockNumber,
        firstBad.blockNumber,
      );
      if ("error" in firstBadCheck) {
        return {
          status: firstBadCheck.status,
          localHead,
          error: firstBadCheck.error,
        };
      }

      if (!firstBadCheck[0].matches) {
        return {
          status: "failed",
          localHead,
          error: `First bad block ${firstBad.blockNumber} is still mismatched after revert`,
        };
      }
    }

    return {
      status: "healthy",
      localHead,
    };
  }

  private async finishServiceReconcile(
    result: ReconcileResult,
    shouldResumeAfterRepair: boolean,
    allowAutoRestart: boolean,
    fallbackEndBlock: number | "latest" | null,
  ): Promise<void> {
    if (result.status === "failed") {
      this.persistFailedReconcileResult(result, shouldResumeAfterRepair);
      return;
    }

    if (result.status === "deferred") {
      this.stateStore.markReconciling(shouldResumeAfterRepair);
      return;
    }

    this.clearFailureStreak();

    if (this.syncController.hasActiveProcess()) {
      return;
    }

    const intended = this.stateStore.getIntendedTarget();
    const restartTarget = intended?.syncTo ?? fallbackEndBlock;
    const shouldRestart =
      allowAutoRestart &&
      shouldResumeAfterRepair &&
      result.resumeFrom !== undefined &&
      restartTarget !== null;

    if (!shouldRestart) {
      this.stateStore.restoreIdleAfterReconcile();
      return;
    }

    if (!this.startSyncHandler) {
      logger.warn("⚠️ No startSync handler registered for reconcile restart");
      return;
    }

    const endBlock =
      restartTarget === "latest" || intended?.isContinuous
        ? "latest"
        : restartTarget;
    this.stateStore.patchState({
      status: "reconciling",
      resumeAfterReconcile: true,
      currentBlock: result.resumeFrom,
    });

    await this.startSyncHandler(endBlock, {
      startBlock: result.resumeFrom,
      skipReconcile: true,
    });
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}

export const reconcileManager = new ReconcileManager();
