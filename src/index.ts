import express from "express";
import logger from "./logger.js";
import { config } from "./config.js";
import { persistence } from "./persistence.js";
import { syncStateManager } from "./state/index.js";
import {
  snapSyncEndpoint,
  cancelSnapSync,
  getSnapSyncStatus,
  start_snap_sync,
} from "./snapSync.js";

const app = express();
app.use(express.json());

// ========================================
// Health Check Endpoint
// ========================================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: "transaction_replay_service",
    redis: persistence.isConnected() ? "connected" : "disconnected",
    activeProcesses: {
      sequential: syncStateManager.isSequentialSyncRunning(),
      snapSync: syncStateManager.isSnapSyncRunning(),
    },
  });
});

// ========================================
// Sync Endpoints (Parallel)
// ========================================
app.post("/sync", snapSyncEndpoint);
app.post("/sync/cancel", cancelSnapSync);
app.get("/snap/status", getSnapSyncStatus);

// ========================================
// Clean Slate Handler
// ========================================
async function handleCleanSlate(): Promise<void> {
  if (!config.cleanSlate) {
    logger.info("ℹ️  CLEAN_SLATE not enabled - preserving existing Redis data");
    return;
  }

  logger.warn("⚠️  CLEAN_SLATE=true detected - clearing all Redis data!");

  // Wait for Redis to connect
  let retries = 0;
  while (!persistence.isConnected() && retries < 10) {
    logger.info("⏳ Waiting for Redis connection before cleaning...");
    await new Promise((resolve) => setTimeout(resolve, 500));
    retries++;
  }

  if (!persistence.isConnected()) {
    logger.error("❌ Redis not connected - cannot perform clean slate");
    throw new Error("Redis not connected for clean slate operation");
  }

  try {
    const deleted = await persistence.clearAllSyncData();
    logger.info(`✅ Clean slate complete - removed ${deleted} process(es)`);
    logger.info("🆕 Starting with fresh Redis state");
  } catch (error) {
    logger.error("❌ Failed to perform clean slate:", error);
    throw error;
  }
}

// ========================================
// Auto-Resume Handler
// ========================================
async function autoResumeOnStartup(): Promise<void> {
  try {
    if (!persistence.isConnected()) {
      logger.warn(
        "⚠️  Redis not connected - will retry auto-resume when connected",
      );
      return;
    }

    logger.info("🔍 Checking Redis for incomplete sync processes...");

    const activeProcess = await persistence.getMostRecentActiveProcess();

    if (!activeProcess) {
      logger.info("✅ No incomplete sync processes found in Redis");
      return;
    }

    const isContinuous = activeProcess.isContinuous === "true";
    const originalTarget = activeProcess.originalTarget
      ? parseInt(activeProcess.originalTarget)
      : undefined;

    const mode = isContinuous ? "CONTINUOUS" : "FIXED";
    logger.info(
      `📋 Found incomplete process: ${activeProcess.processId} [${mode}]`,
    );
    logger.info(
      `📊 Process details: ${activeProcess.syncFrom} → ${activeProcess.syncTo}`,
    );
    logger.info(`📅 Last checked: ${activeProcess.lastChecked}`);

    if (isContinuous) {
      logger.info(
        `🔄 This is a CONTINUOUS sync process (original target: ${originalTarget})`,
      );
      logger.info(
        `📍 Current target has been dynamically updated to: ${activeProcess.syncTo}`,
      );
    }

    const endBlock = isContinuous ? "latest" : activeProcess.syncTo;

    logger.info(
      `\n🔄 Auto-resuming sync process ${activeProcess.processId}...`,
    );

    if (isContinuous) {
      logger.info(
        `🔄 Restarting in CONTINUOUS mode - will fetch latest target and continue tracking`,
      );
    }

    try {
      const result = await start_snap_sync(endBlock);

      if (result.alreadyComplete) {
        logger.info(
          `✅ Process ${activeProcess.processId} is already complete`,
        );
        await persistence.updateStatus(activeProcess.processId, "completed");
      } else {
        logger.info(
          `✅ Successfully auto-resumed snap sync process ${activeProcess.processId}`,
        );
        logger.info(`📊 Resuming from block ${result.syncFrom}`);

        if (isContinuous) {
          logger.info(
            `🔄 Continuous sync mode reactivated - probe loop will track new blocks`,
          );
        }
      }
    } catch (error: any) {
      if (error.code === "SYNC_IN_PROGRESS") {
        logger.info(`ℹ️  Snap sync already in progress - ${error.message}`);
      } else {
        logger.error(
          `❌ Failed to auto-resume snap sync process ${activeProcess.processId}:`,
          error,
        );
        await persistence.updateStatus(activeProcess.processId, "failed");
      }
    }
  } catch (error) {
    logger.error("❌ Error in auto-resume on startup:", error);
  }
}

// ========================================
// Graceful Shutdown Handler
// ========================================
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`\n👋 Received ${signal} - shutting down gracefully...`);

  try {
    // Stop all probes
    await syncStateManager.shutdown();

    // Close persistence layer
    await persistence.close();

    logger.info("✅ Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("❌ Error during graceful shutdown:", error);
    process.exit(1);
  }
}

// ========================================
// Main Function
// ========================================
async function main() {
  try {
    app.listen(config.port, async () => {
      logger.info(`🌐 Syncing service listening on port ${config.port}`);

      // Wait for Redis to connect
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Handle clean slate if enabled
      await handleCleanSlate();

      logger.info("🚀 Starting Transaction Replay Service");

      // Auto-resume any incomplete processes
      await autoResumeOnStartup();

      logger.info("✅ Service fully initialized and ready");
      logger.info("📌 Available endpoints:");
      logger.info("  • GET  /health - Health check");
      logger.info(
        "  • POST /sync - Sequential transaction processing, Parallel receipt waiting",
      );
      logger.info("  • POST /sync/cancel - Cancel sync");
      logger.info("  • GET  /sync/status - Get sync status");
      logger.info("📌 Continuous sync:");
      logger.info("  • Use endBlock: 'latest' in any sync request");
      logger.info("  • System will automatically follow new blocks");
      logger.info("  • Auto-resume works for continuous sync processes");
    });

    // Register shutdown handlers
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

    // Handle uncaught errors
    process.on("unhandledRejection", (reason, promise) => {
      logger.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
    });

    process.on("uncaughtException", (error) => {
      logger.error("❌ Uncaught Exception:", error);
      gracefulShutdown("UNCAUGHT_EXCEPTION");
    });
  } catch (error) {
    logger.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

main();
