import dotenv from "dotenv";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";

import {
  syncEndpoint,
  getSyncStatus,
  cancelSync,
  gracefulShutdown,
  getProcessHistory,
  resumeSync, // ✨ NEW: Import resume function
  autoResumeOnStartup, // ✨ NEW: Import auto-resume function
} from "./syncing.js";
import logger from "./logger.js";

dotenv.config();

const app = express();

// parse application/json
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: "transaction_replay_service",
  });
});

// Start sync process - returns immediately with process ID
app.post("/sync", syncEndpoint);

// ✨ NEW: Resume sync from Redis state
app.post("/sync/resume/:processId", resumeSync);

// Get status of sync process
app.get("/sync/status/:processId", getSyncStatus); // For specific process
app.get("/sync/status", getSyncStatus); // For current process

// Cancel sync process
app.post("/sync/cancel/:processId", cancelSync); // Cancel specific process
app.post("/sync/cancel", cancelSync); // Cancel current process
app.delete("/sync/:processId", cancelSync); // Alternative endpoint for specific process

// Get process history
app.get("/sync/history", getProcessHistory);

app.listen(PORT, async () => {
  logger.info(`Syncing service listening on port ${PORT}`);

  // ✨ NEW: Auto-resume incomplete syncs from Redis
  setTimeout(async () => {
    try {
      await autoResumeOnStartup();
    } catch (error) {
      logger.error("Failed to auto-resume on startup:", error);
    }
  }, 2000); // Wait 2 seconds for service to fully initialize
});
