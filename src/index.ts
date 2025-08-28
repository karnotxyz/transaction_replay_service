import dotenv from "dotenv";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";

import { syncBlocks } from "./sync_blocks.js";
import logger from "./logger.js";
// import { verifyEvents } from "./verify_events.js";

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
    service: "transaction_replay_service"
  });
});

app.post("/sync", async (req: Request, res: Response) => {
  try {
    await syncBlocks(req.body.syncFrom, req.body.syncTo);
    res.status(200).send("Syncing started");
  } catch (e) {
    console.error(e);
    res.status(500).send(`Error syncing - ${e}`);
  }
});

// app.post("/verifyEvents", async (_req: Request, res: Response) => {
//   try {
//     await verifyEvents();
//     res.status(200).send("Verification started");
//   } catch (e) {
//     console.error(e);
//     res.status(500).send(`Error verifying - ${e}`);
//   }
// });

app.listen(PORT, () => {
  logger.info(`Syncing service listening on port ${PORT}`);
});
