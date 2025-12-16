// Initialize OpenTelemetry FIRST, before any other imports
import { initializeTelemetry, shutdownTelemetry } from "./telemetry/config.js";
initializeTelemetry();

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
import { metricsMiddleware } from "./telemetry/middleware.js";
import { BlockHashMismatchError } from "./errors/index.js";

const app = express();
app.use(express.json());
app.use(metricsMiddleware);

// ========================================
// Health Check Endpoint
// ========================================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: "transaction_replay_service",
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
    logger.info("ℹ️  CLEAN_SLATE not enabled - preserving existing state");
    return;
  }

  logger.warn("⚠️  CLEAN_SLATE=true detected - clearing state file!");

  try {
    persistence.clearState();
    logger.info("✅ Clean slate complete - state file removed");
    logger.info("🆕 Starting with fresh state");
  } catch (error) {
    logger.error("❌ Failed to perform clean slate:", error);
    throw error;
  }
}

// ========================================
// Recovery Handler (replaces auto-resume)
// ========================================
async function recoverOnStartup(): Promise<void> {
  try {
    // Check if there's already a process running in-memory
    if (syncStateManager.isSnapSyncRunning()) {
      const currentProcess = syncStateManager.getSnapSyncProcess()!;
      logger.info(
        `ℹ️  Snap sync already running in-memory (Process ID: ${currentProcess.id})`,
      );
      return;
    }

    // Check state file
    if (!persistence.stateExists()) {
      logger.info("✅ No state file found - waiting for RPC call to start sync");
      return;
    }

    const state = persistence.readState();

    if (!state) {
      logger.info("✅ Could not read state file - waiting for RPC call to start sync");
      return;
    }

    if (state.status !== "running") {
      logger.info(`✅ State file shows status="${state.status}" - waiting for RPC call to start sync`);
      return;
    }

    // State says we should be running - validate and recover
    logger.info("🔍 Found running state - validating chain integrity...");

    try {
      const recovery = await persistence.validateAndGetResumePoint();

      logger.info(`✅ Chain integrity validated`);
      logger.info(`🔄 Resuming sync from block ${recovery.resumeFrom}`);

      const mode = recovery.isContinuous ? "CONTINUOUS" : "FIXED";
      logger.info(`📋 Mode: ${mode}, Target: ${recovery.syncTo}`);

      // Start sync from recovery point
      const result = await start_snap_sync(
        recovery.isContinuous ? "latest" : recovery.syncTo,
      );

      if (result.alreadyComplete) {
        logger.info("✅ Sync already complete - marking as idle");
        persistence.stopSync();
      } else {
        logger.info(`✅ Successfully recovered sync process ${result.processId}`);
      }
    } catch (error) {
      if (error instanceof BlockHashMismatchError) {
        logger.error("❌ FATAL: Block hash mismatch detected!");
        logger.error("❌ Chain integrity compromised - cannot recover safely");
        logger.error("❌ Exiting with error code 1");
        process.exit(1);
      }
      throw error;
    }
  } catch (error) {
    logger.error("❌ Error during recovery:", error);
    // For non-hash-mismatch errors, mark as idle and let operator investigate
    persistence.stopSync();
    throw error;
  }
}

// ========================================
// Graceful Shutdown Handler
// ========================================
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`👋 Received ${signal} - shutting down gracefully...`);

  try {
    // Stop all probes
    await syncStateManager.shutdown();

    // Shutdown OpenTelemetry
    await shutdownTelemetry();

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

      // Handle clean slate first
      await handleCleanSlate();

      logger.info("🚀 Starting Transaction Replay Service");

      // Recover any incomplete sync
      await recoverOnStartup();

      logger.info("✅ Service fully initialized and ready");
      logger.info("📌 Available endpoints:");
      logger.info("  • GET  /health - Health check");
      logger.info(
        "  • POST /sync - Start sync with {endBlock: number | 'latest'}",
      );
      logger.info("  • POST /sync/cancel - Cancel sync");
      logger.info("  • GET  /snap/status - Get sync status");
      logger.info("📌 Continuous sync:");
      logger.info("  • Use endBlock: 'latest' in sync request");
      logger.info("  • System will automatically follow new blocks");
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
