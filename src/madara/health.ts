import axios from "axios";
import logger from "../logger.js";
import { config } from "../config.js";
import { TimeoutConfig } from "../constants.js";
import { MadaraDownError } from "../errors/index.js";

/**
 * Check if Madara node is healthy
 */
export async function checkMadaraHealth(): Promise<boolean> {
  try {
    const healthUrl = `${config.rpcUrlSyncingNode}/health`;
    const response = await axios.get(healthUrl, {
      timeout: TimeoutConfig.MADARA_HEALTH_CHECK_TIMEOUT,
    });
    return response.status === 200 && response.data === "OK";
  } catch (error) {
    return false;
  }
}

/**
 * Wait for Madara to recover with exponential backoff
 * @returns true if recovered, false if timeout exceeded
 */
export async function waitForMadaraRecovery(): Promise<boolean> {
  const startTime = Date.now();
  let attempt = 0;

  logger.warn("🚨 Madara node is down - starting recovery wait...");
  logger.info(
    `⏳ Maximum wait time: ${TimeoutConfig.MADARA_RECOVERY_MAX_WAIT / (60 * 60 * 1000)} hours`,
  );

  while (Date.now() - startTime < TimeoutConfig.MADARA_RECOVERY_MAX_WAIT) {
    attempt++;
    const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);

    logger.info(
      `🔍 Recovery attempt ${attempt} (elapsed: ${elapsedMinutes}m)...`,
    );

    const isHealthy = await checkMadaraHealth();

    if (isHealthy) {
      const recoveryTime = Date.now() - startTime;
      const recoveryMinutes = Math.floor(recoveryTime / 60000);
      const recoverySeconds = Math.floor((recoveryTime % 60000) / 1000);

      logger.info(
        `✅ Madara recovered! (downtime: ${recoveryMinutes}m ${recoverySeconds}s)`,
      );
      return true;
    }

    // Exponential backoff capped at 5 minutes
    const delay = Math.min(Math.pow(2, Math.min(attempt, 8)) * 1000, 300000);
    logger.debug(`⏸️  Madara still down, retrying in ${delay / 1000}s...`);

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  logger.error(
    `❌ Madara recovery timeout - exceeded ${TimeoutConfig.MADARA_RECOVERY_MAX_WAIT / (60 * 60 * 1000)} hour wait period`,
  );
  return false;
}

/**
 * Execute an operation with Madara recovery on failure
 */
export async function executeWithMadaraRecovery<T>(
  operation: () => Promise<T>,
  operationName: string,
  onRecoveryStart?: () => void,
  onRecoverySuccess?: () => void,
  onRecoveryFailure?: () => void,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Check if this is a Madara down error
    if (
      error instanceof MadaraDownError ||
      (error instanceof Error &&
        (error.message.includes("ECONNREFUSED") ||
          error.message.includes("fetch failed")))
    ) {
      logger.warn(`🚨 Madara down detected during ${operationName}`);

      if (onRecoveryStart) {
        onRecoveryStart();
      }

      const recovered = await waitForMadaraRecovery();

      if (!recovered) {
        if (onRecoveryFailure) {
          onRecoveryFailure();
        }
        throw new MadaraDownError(
          `Madara recovery failed during ${operationName} - timeout exceeded`,
        );
      }

      if (onRecoverySuccess) {
        onRecoverySuccess();
      }

      logger.info(`🔄 Retrying ${operationName} after Madara recovery...`);

      // Retry the operation once after recovery
      return await operation();
    }

    // Not a Madara error, propagate
    throw error;
  }
}
