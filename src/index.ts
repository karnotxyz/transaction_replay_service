import express from "express";
import dotenv from "dotenv";
import logger from "./logger.js";
import { persistence } from "./persistence.js";
import { start_sync } from "./startSyncing.js";
import { syncEndpoint, cancelSync, cancelCurrentSync } from "./syncing.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: "transaction_replay_service",
    redis: persistence.isConnected() ? "connected" : "disconnected",
  });
});

// Sync endpoint
app.post("/sync", syncEndpoint);

// Cancel sync endpoint
app.post("/sync/cancel/:processId", cancelSync);

// Cancel sync endpoint
app.post("/sync/cancel", cancelCurrentSync);

// 🆕 Clean slate function - clears all Redis data if CLEAN_SLATE=true
async function handleCleanSlate(): Promise<void> {
  const cleanSlate = process.env.CLEAN_SLATE?.toLowerCase() === "true";

  if (!cleanSlate) {
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

// Auto-resume function
async function autoResumeOnStartup(): Promise<void> {
  try {
    // Wait for Redis to be connected
    if (!persistence.isConnected()) {
      logger.warn(
        "⚠️  Redis not connected - will retry auto-resume when connected",
      );
      return;
    }

    logger.info("🔍 Checking Redis for incomplete sync processes...");

    // Get the most recent active process
    const activeProcess = await persistence.getMostRecentActiveProcess();

    if (!activeProcess) {
      logger.info("✅ No incomplete sync processes found in Redis");
      return;
    }

    logger.info(`📋 Found incomplete process: ${activeProcess.processId}`);
    logger.info(
      `📊 Process details: ${activeProcess.syncFrom} → ${activeProcess.syncTo}`,
    );
    logger.info(`📅 Last checked: ${activeProcess.lastChecked}`);

    // Calculate endBlock from stored syncTo
    const endBlock = activeProcess.syncTo;

    logger.info(
      `\n🔄 Auto-resuming sync process ${activeProcess.processId}...`,
    );

    try {
      // Call start_sync with the stored endBlock
      // start_sync will use pending block to figure out where to actually resume from
      const result = await start_sync(endBlock);

      if (result.alreadyComplete) {
        logger.info(
          `✅ Process ${activeProcess.processId} is already complete`,
        );
        await persistence.updateStatus(activeProcess.processId, "completed");
      } else {
        logger.info(
          `✅ Successfully auto-resumed process ${activeProcess.processId}`,
        );
        logger.info(
          `📊 Resuming from block ${result.syncFrom}, tx ${result.startTxIndex}`,
        );
      }
    } catch (error: any) {
      if (error.code === "SYNC_IN_PROGRESS") {
        logger.info(`ℹ️  Sync already in progress - ${error.message}`);
      } else {
        logger.error(
          `❌ Failed to auto-resume process ${activeProcess.processId}:`,
          error,
        );
        await persistence.updateStatus(activeProcess.processId, "failed");
      }
    }
  } catch (error) {
    logger.error("❌ Error in auto-resume on startup:", error);
  }
}

// Periodic auto-resume check (every 3 minutes)
let periodicCheckInterval: NodeJS.Timeout | null = null;

function startPeriodicAutoResume(): void {
  const CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

  logger.info(
    `⏰ Starting periodic auto-resume check (every ${CHECK_INTERVAL_MS / 1000 / 60} minutes)`,
  );

  periodicCheckInterval = setInterval(async () => {
    try {
      // Only check if Redis is connected
      if (!persistence.isConnected()) {
        logger.debug("⏭️  Periodic check skipped - Redis not connected");
        return;
      }

      logger.info("🔍 Periodic auto-resume check...");
      await autoResumeOnStartup();
    } catch (error) {
      logger.error("❌ Error in periodic auto-resume check:", error);
    }
  }, CHECK_INTERVAL_MS);
}

// Main function
async function main() {
  console.log("🚀 Starting Transaction Replay Service");

  try {
    app.listen(PORT, async () => {
      logger.info(`🌐 Syncing service listening on port ${PORT}`);

      // Wait for Redis to connect
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 🆕 Handle clean slate if enabled
      await handleCleanSlate();

      // Auto-resume any incomplete processes (unless clean slate was performed)
      await autoResumeOnStartup();

      // Start periodic checks
      startPeriodicAutoResume();

      logger.info("✅ Service fully initialized and ready");
    });

    process.on("SIGINT", async () => {
      logger.info("\n👋 Shutting down gracefully...");
      if (periodicCheckInterval) clearInterval(periodicCheckInterval);
      await persistence.close();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      logger.info("\n👋 Shutting down gracefully...");
      if (periodicCheckInterval) clearInterval(periodicCheckInterval);
      await persistence.close();
      process.exit(0);
    });
  } catch (error) {
    logger.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

main();
