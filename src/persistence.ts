import fs from "fs";
import path from "path";
import logger from "./logger.js";
import { SyncState } from "./types.js";
import { config } from "./config.js";
import { ProcessStatus } from "./constants.js";

type PersistedStatus = SyncState["status"];

/**
 * File-based persistence layer for sync state.
 */
class PersistenceLayer {
  private readonly filePath: string;

  constructor() {
    this.filePath = config.stateFilePath;
    this.ensureDirectoryExists();
  }

  private ensureDirectoryExists(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`📁 Created directory for state file: ${dir}`);
    }
  }

  private createDefaultState(): SyncState {
    return {
      status: "idle",
      syncTo: null,
      isContinuous: false,
      currentBlock: null,
      lastVerifiedBlock: null,
      lastVerifiedHash: null,
      resumeAfterReconcile: false,
      reconcileFailureBlock: null,
      reconcileFailureCount: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  private normalizeState(rawState: Partial<SyncState>): SyncState {
    const defaultState = this.createDefaultState();

    return {
      status: rawState.status ?? defaultState.status,
      syncTo:
        rawState.syncTo === undefined ? defaultState.syncTo : rawState.syncTo,
      isContinuous: rawState.isContinuous ?? defaultState.isContinuous,
      currentBlock:
        rawState.currentBlock === undefined
          ? defaultState.currentBlock
          : rawState.currentBlock,
      lastVerifiedBlock:
        rawState.lastVerifiedBlock === undefined
          ? defaultState.lastVerifiedBlock
          : rawState.lastVerifiedBlock,
      lastVerifiedHash:
        rawState.lastVerifiedHash === undefined
          ? defaultState.lastVerifiedHash
          : rawState.lastVerifiedHash,
      resumeAfterReconcile:
        rawState.resumeAfterReconcile ?? defaultState.resumeAfterReconcile,
      reconcileFailureBlock:
        rawState.reconcileFailureBlock === undefined
          ? defaultState.reconcileFailureBlock
          : rawState.reconcileFailureBlock,
      reconcileFailureCount:
        rawState.reconcileFailureCount === undefined
          ? defaultState.reconcileFailureCount
          : rawState.reconcileFailureCount,
      updatedAt: rawState.updatedAt ?? defaultState.updatedAt,
    };
  }

  public readState(): SyncState | null {
    try {
      if (!fs.existsSync(this.filePath)) {
        return null;
      }

      const content = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<SyncState>;
      return this.normalizeState(parsed);
    } catch (error) {
      logger.error(`❌ Failed to read state file: ${error}`);
      return null;
    }
  }

  public writeState(state: SyncState): void {
    try {
      const tempPath = `${this.filePath}.tmp`;
      const content = JSON.stringify(state, null, 2);

      fs.writeFileSync(tempPath, content, "utf-8");
      fs.renameSync(tempPath, this.filePath);

      logger.info(`💾 State saved: status=${state.status}`);
    } catch (error) {
      logger.error(`❌ Failed to write state file: ${error}`);
      throw error;
    }
  }

  public stateExists(): boolean {
    return fs.existsSync(this.filePath);
  }

  public clearState(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
        logger.info(`🗑️  State file deleted`);
      }
    } catch (error) {
      logger.error(`❌ Failed to delete state file: ${error}`);
      throw error;
    }
  }

  public patchState(patch: Partial<SyncState>): SyncState | null {
    const currentState = this.readState() ?? this.createDefaultState();
    const nextState = this.normalizeState({
      ...currentState,
      ...patch,
      updatedAt: new Date().toISOString(),
    });

    this.writeState(nextState);
    return nextState;
  }

  public startSync(
    syncTo: number | "latest",
    isContinuous: boolean,
    currentBlock: number,
  ): void {
    const currentState = this.readState();
    const defaultLastVerifiedBlock =
      currentBlock > 0 ? currentBlock - 1 : null;

    const state: SyncState = this.normalizeState({
      status: ProcessStatus.RUNNING,
      syncTo,
      isContinuous,
      currentBlock,
      lastVerifiedBlock:
        currentState?.lastVerifiedBlock ?? defaultLastVerifiedBlock,
      lastVerifiedHash: currentState?.lastVerifiedHash ?? null,
      resumeAfterReconcile: false,
      reconcileFailureBlock: null,
      reconcileFailureCount: 0,
    });

    this.writeState(state);
  }

  public stopSync(): void {
    const currentState = this.readState();
    const state: SyncState = this.normalizeState({
      status: "idle",
      syncTo: null,
      isContinuous: false,
      currentBlock: null,
      lastVerifiedBlock: currentState?.lastVerifiedBlock ?? null,
      lastVerifiedHash: currentState?.lastVerifiedHash ?? null,
      resumeAfterReconcile: false,
      reconcileFailureBlock: null,
      reconcileFailureCount: 0,
    });

    this.writeState(state);
  }

  public updateSyncTarget(newTarget: number): void {
    const currentState = this.readState();
    if (currentState && currentState.status === ProcessStatus.RUNNING) {
      this.patchState({ syncTo: newTarget });
    }
  }

  public markCurrentBlock(currentBlock: number): void {
    const currentState = this.readState();
    if (!currentState) {
      return;
    }

    this.patchState({ currentBlock });
  }

  public markBlockVerified(blockNumber: number, blockHash: string): void {
    const currentState = this.readState();
    if (!currentState) {
      return;
    }

    this.patchState({
      currentBlock: blockNumber + 1,
      lastVerifiedBlock: blockNumber,
      lastVerifiedHash: blockHash,
      reconcileFailureBlock: null,
      reconcileFailureCount: 0,
    });
  }

  public markReconciling(resumeAfterReconcile: boolean): void {
    this.patchState({
      status: "reconciling",
      resumeAfterReconcile,
    });
  }

  public markReconcileFailed(resumeAfterReconcile: boolean): void {
    this.patchState({
      status: "reconcile_failed",
      resumeAfterReconcile,
    });
  }

  public restoreIdleAfterReconcile(): void {
    const currentState = this.readState();
    if (!currentState) {
      this.stopSync();
      return;
    }

    this.patchState({
      status: "idle",
      syncTo: null,
      isContinuous: false,
      currentBlock: currentState.lastVerifiedBlock === null
        ? null
        : currentState.lastVerifiedBlock + 1,
      resumeAfterReconcile: false,
      reconcileFailureBlock: null,
      reconcileFailureCount: 0,
    });
  }

  public shouldBeRunning(): boolean {
    const state = this.readState();
    return state !== null && state.status === ProcessStatus.RUNNING;
  }

  public shouldAutoResumeOnStartup(): boolean {
    const state = this.readState();
    if (!state) {
      return false;
    }

    if (state.status === ProcessStatus.RUNNING) {
      return true;
    }

    return state.status === "reconciling" && state.resumeAfterReconcile;
  }

  public isHardReconcileFailure(): boolean {
    const state = this.readState();
    return state?.status === "reconcile_failed";
  }

  public getIntendedTarget(): {
    syncTo: number | "latest" | null;
    isContinuous: boolean;
    resumeAfterReconcile: boolean;
    status: PersistedStatus;
  } | null {
    const state = this.readState();
    if (!state) {
      return null;
    }

    return {
      syncTo: state.syncTo,
      isContinuous: state.isContinuous,
      resumeAfterReconcile: state.resumeAfterReconcile,
      status: state.status,
    };
  }
}

export const persistence = new PersistenceLayer();
