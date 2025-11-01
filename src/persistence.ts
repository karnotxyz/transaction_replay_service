// persistence.ts
import Redis from "ioredis";
import logger from "./logger.js";
import { StoredSyncProcess } from "./types.js";

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
      enableOfflineQueue: true,
    });

    this.redis.on("connect", () => {
      logger.info("✅ Redis connected successfully");
      this.connected = true;
    });

    this.redis.on("error", (err) => {
      logger.error(`❌ Redis error: ${err.message}`);
      this.connected = false;
    });

    this.redis.on("close", () => {
      logger.warn("⚠️  Redis connection closed");
      this.connected = false;
    });

    this.redis.on("reconnecting", () => {
      logger.info("🔄 Redis reconnecting...");
    });
  }

  // Check if connected
  isConnected(): boolean {
    return this.connected;
  }

  // 🆕 Clear all sync data from Redis
  async clearAllSyncData(): Promise<number> {
    try {
      logger.warn("🧹 Clearing all sync data from Redis...");

      // Get all sync keys
      const keys = await this.redis.keys("sync:*");

      if (keys.length === 0) {
        logger.info("✅ No sync data found in Redis (already clean)");
        return 0;
      }

      // Delete all sync keys
      const deleted = await this.redis.del(...keys);

      logger.info(`✅ Cleared ${deleted} sync process(es) from Redis`);
      return deleted;
    } catch (error) {
      logger.error(`❌ Failed to clear Redis data: ${error}`);
      throw error;
    }
  }

  // Save sync process metadata (with continuous sync support)
  async saveSyncProcess(
    processId: string,
    syncFrom: number,
    syncTo: number,
    isContinuous: boolean = false,
    originalTarget?: number,
  ): Promise<void> {
    const key = `sync:${processId}`;
    const data: Record<string, string> = {
      processId,
      syncFrom: syncFrom.toString(),
      syncTo: syncTo.toString(),
      status: "running",
      createdAt: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      isContinuous: isContinuous.toString(),
    };

    if (originalTarget !== undefined) {
      data.originalTarget = originalTarget.toString();
    }

    await this.redis.hmset(key, data);

    const mode = isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `💾 Saved sync process ${processId} (${syncFrom} → ${syncTo}) [${mode}]`,
    );
  }

  // Get sync process metadata
  async getSyncProcess(processId: string): Promise<StoredSyncProcess | null> {
    const key = `sync:${processId}`;
    const data = await this.redis.hgetall(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      processId: data.processId,
      syncFrom: parseInt(data.syncFrom),
      syncTo: parseInt(data.syncTo),
      status: data.status as any,
      createdAt: data.createdAt || new Date().toISOString(),
      lastChecked:
        data.lastChecked || data.lastUpdated || new Date().toISOString(),
      isContinuous: data.isContinuous,
      originalTarget: data.originalTarget,
    };
  }

  // Update sync target (for continuous sync when new blocks are detected)
  async updateSyncTarget(processId: string, newTarget: number): Promise<void> {
    const key = `sync:${processId}`;
    await this.redis.hset(key, "syncTo", newTarget.toString());
    await this.redis.hset(key, "lastChecked", new Date().toISOString());
    logger.info(`📈 Updated process ${processId} target to block ${newTarget}`);
  }

  // Update last checked timestamp
  async updateLastChecked(processId: string): Promise<void> {
    const key = `sync:${processId}`;
    await this.redis.hset(key, "lastChecked", new Date().toISOString());
  }

  // Update status
  async updateStatus(
    processId: string,
    status: "running" | "completed" | "failed" | "cancelled",
  ): Promise<void> {
    const key = `sync:${processId}`;
    await this.redis.hset(key, "status", status);
    await this.redis.hset(key, "lastChecked", new Date().toISOString());
    logger.info(`📝 Updated process ${processId} status to ${status}`);
  }

  // Get all active (running) processes
  async getActiveProcesses(): Promise<StoredSyncProcess[]> {
    const keys = await this.redis.keys("sync:*");
    const processes: StoredSyncProcess[] = [];

    for (const key of keys) {
      const status = await this.redis.hget(key, "status");
      if (status === "running") {
        const processId = key.replace("sync:", "");
        const process = await this.getSyncProcess(processId);
        if (process) {
          processes.push(process);
        }
      }
    }

    return processes;
  }

  // Get the most recent active process (for auto-resume)
  async getMostRecentActiveProcess(): Promise<StoredSyncProcess | null> {
    const activeProcesses = await this.getActiveProcesses();

    if (activeProcesses.length === 0) {
      return null;
    }

    // Sort by lastChecked (most recent first)
    activeProcesses.sort((a, b) => {
      return (
        new Date(b.lastChecked).getTime() - new Date(a.lastChecked).getTime()
      );
    });

    return activeProcesses[0];
  }

  // Delete a process
  async deleteProcess(processId: string): Promise<void> {
    const key = `sync:${processId}`;
    await this.redis.del(key);
    logger.info(`🗑️  Deleted process ${processId}`);
  }

  // Close connection
  async close(): Promise<void> {
    await this.redis.quit();
    logger.info("👋 Redis connection closed");
  }
}

// Singleton instance
export const persistence = new PersistenceLayer();
