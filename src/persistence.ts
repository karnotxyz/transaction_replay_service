import Redis from "ioredis";
import logger from "./logger.js";

class PersistenceLayer {
  private redis: Redis.Redis;
  private connected: boolean = false;

  constructor() {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    this.redis = new Redis.Redis(redisUrl, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    this.redis.on("connect", () => {
      logger.info("Redis connected successfully");
      this.connected = true;
    });

    this.redis.on("error", (err) => {
      logger.error(`Redis error: ${err.message}`);
      this.connected = false;
    });
  }

  // Save sync process metadata
  async saveSyncProcess(
    processId: string,
    syncFrom: number,
    syncTo: number,
    startTxIndex: number
  ): Promise<void> {
    const key = `sync:${processId}`;
    await this.redis.hmset(key, {
      syncFrom: syncFrom.toString(),
      syncTo: syncTo.toString(),
      currentBlock: syncFrom.toString(),
      currentTxIndex: startTxIndex.toString(),
      status: "running",
      createdAt: new Date().toISOString(),
    });
    logger.info(`Saved sync process ${processId}`);
  }

  // Update current progress
  async updateProgress(
    processId: string,
    currentBlock: number,
    currentTxIndex: number
  ): Promise<void> {
    const key = `sync:${processId}`;
    await this.redis.hmset(key, {
      currentBlock: currentBlock.toString(),
      currentTxIndex: currentTxIndex.toString(),
      lastUpdated: new Date().toISOString(),
    });
  }

  // Get sync process state
  async getSyncProcess(processId: string): Promise<{
    syncFrom: number;
    syncTo: number;
    currentBlock: number;
    currentTxIndex: number;
    status: string;
  } | null> {
    const key = `sync:${processId}`;
    const data = await this.redis.hgetall(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      syncFrom: parseInt(data.syncFrom),
      syncTo: parseInt(data.syncTo),
      currentBlock: parseInt(data.currentBlock),
      currentTxIndex: parseInt(data.currentTxIndex),
      status: data.status,
    };
  }

  // Update status
  async updateStatus(processId: string, status: string): Promise<void> {
    const key = `sync:${processId}`;
    await this.redis.hset(key, "status", status);
    await this.redis.hset(key, "lastUpdated", new Date().toISOString());
    logger.info(`Updated process ${processId} status to ${status}`);
  }

  // Get all active processes
  async getActiveProcesses(): Promise<string[]> {
    const keys = await this.redis.keys("sync:*");
    const processes: string[] = [];

    for (const key of keys) {
      const status = await this.redis.hget(key, "status");
      if (status === "running") {
        processes.push(key.replace("sync:", ""));
      }
    }

    return processes;
  }

  // Check if connected
  isConnected(): boolean {
    return this.connected;
  }

  // Check if process should be resumed
  async shouldResumeProcess(
    processId: string,
    originalProvider: any
  ): Promise<boolean> {
    const state = await this.getSyncProcess(processId);

    if (!state) return false;
    if (state.status !== "running") return false;

    // Check if this is a continuous sync (syncTo = 999999999 means "LATEST")
    const isContinuousSync = state.syncTo === 999999999;

    if (isContinuousSync) {
      // For continuous syncs, ALWAYS resume - they never "complete"
      logger.info(
        `Process ${processId} is continuous sync - will resume from block ${state.currentBlock}, tx ${state.currentTxIndex}`
      );
      return true;
    }

    // For fixed-range syncs, check if we're at the very last transaction
    try {
      const lastBlock = await originalProvider.getBlockWithTxs(state.syncTo);
      const totalTransactions = lastBlock.transactions.length;

      // Don't resume if at last block AND last transaction
      if (
        state.currentBlock === state.syncTo &&
        state.currentTxIndex === totalTransactions - 1
      ) {
        logger.info(
          `Process ${processId} is at last transaction - marking as completed`
        );
        await this.updateStatus(processId, "completed");
        return false;
      }

      return true;
    } catch (error) {
      logger.warn(`Error checking if process ${processId} should resume: ${error}`);
      return false;
    }
  }

  // Get all resumable processes
  async getResumableProcesses(): Promise<string[]> {
    const keys = await this.redis.keys("sync:*");
    const resumable: string[] = [];

    for (const key of keys) {
      const status = await this.redis.hget(key, "status");
      if (status === "running") {
        resumable.push(key.replace("sync:", ""));
      }
    }

    return resumable;
  }

  // Close connection
  async close(): Promise<void> {
    await this.redis.quit();
    logger.info("Redis connection closed");
  }
}

// Singleton instance
export const persistence = new PersistenceLayer();
