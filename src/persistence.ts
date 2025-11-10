import Redis from "ioredis";
import logger from "./logger.js";
import { StoredSyncProcess } from "./types.js";
import { config } from "./config.js";
import {
  RedisKeys,
  TimeoutConfig,
  ProcessStatus,
  ProcessStatusType,
} from "./constants.js";
import { updateRedisConnectionStatus } from "./telemetry/metrics.js";

class PersistenceLayer {
  private redis: Redis.Redis;
  private connected: boolean = false;
  private hasConnectedOnce: boolean = false; // Track if we've ever connected
  private reconnectionCallback: (() => Promise<void>) | null = null;

  constructor() {
    this.redis = new Redis.Redis(config.redisUrl, {
      retryStrategy: (times) => {
        const delay = Math.min(times * TimeoutConfig.REDIS_RETRY_DELAY, 2000);
        return delay;
      },
      maxRetriesPerRequest: TimeoutConfig.REDIS_MAX_RETRIES,
      enableOfflineQueue: true,
      connectTimeout: TimeoutConfig.REDIS_CONNECT_TIMEOUT,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.redis.on("connect", async () => {
      logger.info("✅ Redis connected successfully");
      const isReconnection = this.hasConnectedOnce; // true only if we connected before
      this.connected = true;
      this.hasConnectedOnce = true; // Mark that we've connected at least once
      updateRedisConnectionStatus(true);

      // Only trigger reconnection callback on actual reconnections
      // (not on initial startup connection)
      if (isReconnection && this.reconnectionCallback) {
        logger.info("🔄 Triggering auto-resume after Redis reconnection...");
        try {
          await this.reconnectionCallback();
        } catch (error) {
          logger.error("❌ Error in reconnection callback:", error);
        }
      }
    });

    this.redis.on("error", (err) => {
      logger.error(`❌ Redis error: ${err.message}`);
      this.connected = false;
      updateRedisConnectionStatus(false);
    });

    this.redis.on("close", () => {
      logger.warn("⚠️  Redis connection closed");
      this.connected = false;
      updateRedisConnectionStatus(false);
    });

    this.redis.on("reconnecting", () => {
      logger.info("🔄 Redis reconnecting...");
    });
  }

  /**
   * Register a callback to be invoked when Redis reconnects
   */
  public setReconnectionCallback(callback: () => Promise<void>): void {
    this.reconnectionCallback = callback;
  }

  /**
   * Check if Redis is connected
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Clear all sync data from Redis
   */
  public async clearAllSyncData(): Promise<number> {
    try {
      logger.warn("🧹 Clearing all sync data from Redis...");

      const keys = await this.redis.keys(`${RedisKeys.SYNC_PROCESS_PREFIX}*`);

      if (keys.length === 0) {
        logger.info("✅ No sync data found in Redis (already clean)");
        return 0;
      }

      const deleted = await this.redis.del(...keys);

      logger.info(`✅ Cleared ${deleted} sync process(es) from Redis`);
      return deleted;
    } catch (error) {
      logger.error(`❌ Failed to clear Redis data: ${error}`);
      throw error;
    }
  }

  /**
   * Save sync process metadata
   */
  public async saveSyncProcess(
    processId: string,
    syncFrom: number,
    syncTo: number,
    isContinuous: boolean = false,
    originalTarget?: number,
  ): Promise<void> {
    const key = `${RedisKeys.SYNC_PROCESS_PREFIX}${processId}`;
    const data: Record<string, string> = {
      processId,
      syncFrom: syncFrom.toString(),
      syncTo: syncTo.toString(),
      status: ProcessStatus.RUNNING,
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

  /**
   * Get sync process metadata
   */
  public async getSyncProcess(
    processId: string,
  ): Promise<StoredSyncProcess | null> {
    const key = `${RedisKeys.SYNC_PROCESS_PREFIX}${processId}`;
    const data = await this.redis.hgetall(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      processId: data.processId,
      syncFrom: parseInt(data.syncFrom),
      syncTo: parseInt(data.syncTo),
      status: data.status as ProcessStatusType,
      createdAt: data.createdAt || new Date().toISOString(),
      lastChecked:
        data.lastChecked || data.lastUpdated || new Date().toISOString(),
      isContinuous: data.isContinuous,
      originalTarget: data.originalTarget,
    };
  }

  /**
   * Update sync target (for continuous sync)
   */
  public async updateSyncTarget(
    processId: string,
    newTarget: number,
  ): Promise<void> {
    const key = `${RedisKeys.SYNC_PROCESS_PREFIX}${processId}`;
    await this.redis.hset(key, "syncTo", newTarget.toString());
    await this.redis.hset(key, "lastChecked", new Date().toISOString());
    logger.info(`📈 Updated process ${processId} target to block ${newTarget}`);
  }

  /**
   * Update last checked timestamp
   */
  public async updateLastChecked(processId: string): Promise<void> {
    const key = `${RedisKeys.SYNC_PROCESS_PREFIX}${processId}`;
    await this.redis.hset(key, "lastChecked", new Date().toISOString());
  }

  /**
   * Update process status
   */
  public async updateStatus(
    processId: string,
    status: ProcessStatusType,
  ): Promise<void> {
    const key = `${RedisKeys.SYNC_PROCESS_PREFIX}${processId}`;
    await this.redis.hset(key, "status", status);
    await this.redis.hset(key, "lastChecked", new Date().toISOString());
    logger.info(`📝 Updated process ${processId} status to ${status}`);
  }

  /**
   * Get all active (running) processes
   */
  public async getActiveProcesses(): Promise<StoredSyncProcess[]> {
    const keys = await this.redis.keys(`${RedisKeys.SYNC_PROCESS_PREFIX}*`);
    const processes: StoredSyncProcess[] = [];

    for (const key of keys) {
      const status = await this.redis.hget(key, "status");
      if (status === ProcessStatus.RUNNING) {
        const processId = key.replace(RedisKeys.SYNC_PROCESS_PREFIX, "");
        const process = await this.getSyncProcess(processId);
        if (process) {
          processes.push(process);
        }
      }
    }

    return processes;
  }

  /**
   * Get the most recent active process (for auto-resume)
   */
  public async getMostRecentActiveProcess(): Promise<StoredSyncProcess | null> {
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

  /**
   * Delete a process
   */
  public async deleteProcess(processId: string): Promise<void> {
    const key = `${RedisKeys.SYNC_PROCESS_PREFIX}${processId}`;
    await this.redis.del(key);
    logger.info(`🗑️  Deleted process ${processId}`);
  }

  /**
   * Close Redis connection
   */
  public async close(): Promise<void> {
    await this.redis.quit();
    logger.info("👋 Redis connection closed");
  }
}

// Singleton instance
export const persistence = new PersistenceLayer();
