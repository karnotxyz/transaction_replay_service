import axios from "axios";
import logger from "../logger.js";
import { config } from "../config.js";
import { TimeoutConfig } from "../constants.js";
import { MadaraDownError, isMadaraDownError } from "../errors/index.js";
import {
  updateMadaraHealthStatus,
  incrementMadaraRecoveryEvents,
  recordMadaraDowntime,
} from "../telemetry/metrics.js";

export interface MadaraRecoveryOptions {
  requireObservedDown?: boolean;
  minHealthyChecks?: number;
  healthyCheckDelayMs?: number;
  checkHealth?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxWaitMs?: number;
}

/**
 * Check if Madara node is healthy
 */
export async function checkMadaraHealth(): Promise<boolean> {
  try {
    const healthUrl = `${config.rpcUrlSyncingNode}/health`;
    const response = await axios.get(healthUrl, {
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
export async function waitForMadaraRecovery(
  options: MadaraRecoveryOptions = {},
): Promise<boolean> {
  const {
    requireObservedDown = false,
    minHealthyChecks = 1,
    healthyCheckDelayMs = 1000,
    checkHealth = checkMadaraHealth,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    maxWaitMs = TimeoutConfig.MADARA_RECOVERY_MAX_WAIT,
  } = options;

  const startTime = now();
  let attempt = 0;
  let observedDown = !requireObservedDown;
  let consecutiveHealthyChecks = 0;

  logger.warn("🚨 Madara node is down - starting recovery wait...");
  logger.info(
    `⏳ Maximum wait time: ${maxWaitMs / (60 * 60 * 1000)} hours`,
  );

  while (now() - startTime < maxWaitMs) {
    attempt++;
    const elapsedMinutes = Math.floor((now() - startTime) / 60000);

    logger.info(
      `🔍 Recovery attempt ${attempt} (elapsed: ${elapsedMinutes}m)...`,
    );

    const isHealthy = await checkHealth();

    if (isHealthy) {
      if (!observedDown) {
        logger.info(
          "⏳ Madara is still responding after shutdown request - waiting for the node to go down before accepting recovery",
        );
      } else {
        consecutiveHealthyChecks += 1;

        if (consecutiveHealthyChecks >= minHealthyChecks) {
          const recoveryTime = now() - startTime;
          const recoveryMinutes = Math.floor(recoveryTime / 60000);
          const recoverySeconds = Math.floor((recoveryTime % 60000) / 1000);

          logger.info(
            `✅ Madara recovered! (downtime: ${recoveryMinutes}m ${recoverySeconds}s)`,
          );

          incrementMadaraRecoveryEvents();
          recordMadaraDowntime(recoveryTime / 1000);

          return true;
        }

        logger.info(
          `🔍 Madara health probe ${consecutiveHealthyChecks}/${minHealthyChecks} passed - waiting for stable recovery...`,
        );
      }
    } else {
      consecutiveHealthyChecks = 0;
      if (!observedDown) {
        logger.info("📉 Observed Madara go down after the shutdown request");
      }
      observedDown = true;
    }

    const delay =
      observedDown && consecutiveHealthyChecks > 0
        ? healthyCheckDelayMs
        : Math.min(Math.pow(2, Math.min(attempt, 8)) * 1000, 300000);
    logger.debug(`⏸️  Madara still down, retrying in ${delay / 1000}s...`);

    await sleep(delay);
  }

  logger.error(
    `❌ Madara recovery timeout - exceeded ${maxWaitMs / (60 * 60 * 1000)} hour wait period`,
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

      const recovered = await waitForMadaraRecovery({
        requireObservedDown: true,
        minHealthyChecks: 2,
      });

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
