import fs from "fs";
import path from "path";
import logger from "./logger.js";
import { SyncState } from "./types.js";
import { config } from "./config.js";
import { ProcessStatus, ProcessStatusType } from "./constants.js";
import {
  getLatestBlockNumber,
  getBlockWithTxHashes,
} from "./operations/blockOperations.js";
import { originalProvider_v9, syncingProvider_v9 } from "./providers.js";
import { BlockHashMismatchError } from "./errors/index.js";

/**
 * File-based persistence layer for sync state
 * Replaces Redis with a simple JSON file
 */
class PersistenceLayer {
  private filePath: string;

  constructor() {
    this.filePath = config.stateFilePath;
    this.ensureDirectoryExists();
  }

  /**
   * Ensure the directory for the state file exists
   */
  private ensureDirectoryExists(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`📁 Created directory for state file: ${dir}`);
    }
  }

  /**
   * Read the current sync state from file
   */
  public readState(): SyncState | null {
    try {
      if (!fs.existsSync(this.filePath)) {
        return null;
      }

      const content = fs.readFileSync(this.filePath, "utf-8");
      const state = JSON.parse(content) as SyncState;
      return state;
    } catch (error) {
      logger.error(`❌ Failed to read state file: ${error}`);
      return null;
    }
  }

  /**
   * Write sync state to file atomically
   * Uses write-to-temp-then-rename pattern for safety
   */
  public writeState(state: SyncState): void {
    try {
      const tempPath = `${this.filePath}.tmp`;
      const content = JSON.stringify(state, null, 2);

      // Write to temp file first
      fs.writeFileSync(tempPath, content, "utf-8");

      // Atomic rename
      fs.renameSync(tempPath, this.filePath);

      logger.info(`💾 State saved: status=${state.status}`);
    } catch (error) {
      logger.error(`❌ Failed to write state file: ${error}`);
      throw error;
    }
  }

  /**
   * Check if state file exists
   */
  public stateExists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * Delete state file
   */
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

  /**
   * Mark sync as running
   */
  public startSync(syncTo: number | "latest", isContinuous: boolean): void {
    const state: SyncState = {
      status: ProcessStatus.RUNNING,
      syncTo,
      isContinuous,
      updatedAt: new Date().toISOString(),
    };
    this.writeState(state);
  }

  /**
   * Mark sync as idle (stopped/completed)
   */
  public stopSync(): void {
    const state: SyncState = {
      status: "idle",
      syncTo: null,
      isContinuous: false,
      updatedAt: new Date().toISOString(),
    };
    this.writeState(state);
  }

  /**
   * Update sync target (for continuous sync)
   */
  public updateSyncTarget(newTarget: number): void {
    const currentState = this.readState();
    if (currentState && currentState.status === ProcessStatus.RUNNING) {
      currentState.syncTo = newTarget;
      currentState.updatedAt = new Date().toISOString();
      this.writeState(currentState);
    }
  }

  /**
   * Check if we should be running based on state file
   */
  public shouldBeRunning(): boolean {
    const state = this.readState();
    return state !== null && state.status === ProcessStatus.RUNNING;
  }

  /**
   * Validate chain integrity and get resume point
   * Returns the block number to resume from, or throws on mismatch
   */
  public async validateAndGetResumePoint(): Promise<{
    resumeFrom: number;
    syncTo: number | "latest";
    isContinuous: boolean;
  }> {
    const state = this.readState();

    if (!state || state.status !== ProcessStatus.RUNNING) {
      throw new Error("No running sync state found");
    }

    logger.info("🔍 Validating chain integrity before resume...");

    // Get syncing node's latest block
    const syncingLatest = await getLatestBlockNumber(syncingProvider_v9);
    logger.info(`📊 Syncing node latest block: ${syncingLatest}`);

    // Get the block from syncing node
    const syncingBlock = await getBlockWithTxHashes(
      syncingProvider_v9,
      syncingLatest,
    );

    // Get the same block from original node
    const originalBlock = await getBlockWithTxHashes(
      originalProvider_v9,
      syncingLatest,
    );

    // Extract hashes - handle both confirmed and pending blocks
    const syncingBlockHash =
      "block_hash" in syncingBlock ? syncingBlock.block_hash : null;
    const originalBlockHash =
      "block_hash" in originalBlock ? originalBlock.block_hash : null;
    const syncingParentHash =
      "parent_hash" in syncingBlock ? syncingBlock.parent_hash : null;
    const originalParentHash =
      "parent_hash" in originalBlock ? originalBlock.parent_hash : null;

    logger.info(`🔗 Syncing block ${syncingLatest}:`);
    logger.info(`   block_hash: ${syncingBlockHash}`);
    logger.info(`   parent_hash: ${syncingParentHash}`);
    logger.info(`🔗 Original block ${syncingLatest}:`);
    logger.info(`   block_hash: ${originalBlockHash}`);
    logger.info(`   parent_hash: ${originalParentHash}`);

    // Validate block hash
    if (syncingBlockHash && originalBlockHash) {
      if (syncingBlockHash !== originalBlockHash) {
        logger.error(
          `❌ Block hash mismatch at block ${syncingLatest}!`,
        );
        logger.error(`   Syncing:  ${syncingBlockHash}`);
        logger.error(`   Original: ${originalBlockHash}`);
        throw new BlockHashMismatchError(
          syncingLatest,
          originalBlockHash,
          syncingBlockHash,
        );
      }
      logger.info(`✅ Block hash matches`);
    }

    // Validate parent hash
    if (syncingParentHash && originalParentHash) {
      if (syncingParentHash !== originalParentHash) {
        logger.error(
          `❌ Parent hash mismatch at block ${syncingLatest}!`,
        );
        logger.error(`   Syncing:  ${syncingParentHash}`);
        logger.error(`   Original: ${originalParentHash}`);
        throw new BlockHashMismatchError(
          syncingLatest - 1,
          originalParentHash,
          syncingParentHash,
        );
      }
      logger.info(`✅ Parent hash matches`);
    }

    logger.info(`✅ Chain integrity validated - safe to resume`);

    // Determine sync target
    let syncTo: number | "latest" = state.syncTo ?? "latest";
    if (state.isContinuous) {
      syncTo = "latest";
    }

    return {
      resumeFrom: syncingLatest + 1,
      syncTo,
      isContinuous: state.isContinuous,
    };
  }
}

// Singleton instance
export const persistence = new PersistenceLayer();
