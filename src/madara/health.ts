import logger from "../logger.js";
import { config } from "../config.js";
import { TimeoutConfig } from "../constants.js";
import { MadaraDownError, isMadaraDownError } from "../errors/index.js";
import { rpcHttpClient } from "../rpcClient.js";
import {
  updateMadaraHealthStatus,
  incrementMadaraRecoveryEvents,
  recordMadaraDowntime,
} from "../telemetry/metrics.js";

/**
 * Check if Madara node is healthy
 */
export async function checkMadaraHealth(): Promise<boolean> {
  try {
    const healthUrl = `${config.rpcUrlSyncingNode}/health`;
    const response = await rpcHttpClient.get(healthUrl, {
      timeout: TimeoutConfig.MADARA_HEALTH_CHECK_TIMEOUT,
    });
    const isHealthy = response.status === 200 && response.data === "OK";
    updateMadaraHealthStatus(isHealthy);
    return isHealthy;
  } catch (error) {
    updateMadaraHealthStatus(false);
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

      // Record recovery metrics
      incrementMadaraRecoveryEvents();
      recordMadaraDowntime(recoveryTime / 1000); // Convert to seconds

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
    // Check if this is a Madara down error using comprehensive pattern matching
    if (error instanceof MadaraDownError || isMadaraDownError(error)) {
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
