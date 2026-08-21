import dotenv from "dotenv";
import path from "path";
import logger from "./logger.js";
import { normalizeStarknetVersion } from "./starknetVersion.js";
import { ReplayMode, ReplayModeType } from "./constants.js";
import {
  isMempoolReplayMode,
  isTransactionReplayMode,
  parseReplayMode,
  resolveBlockHashValidation,
} from "./replayMode.js";

dotenv.config();

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

interface EnvironmentConfig {
  // Server
  port: number;
  nodeEnv: string;

  // RPC URLs
  rpcUrlOriginalNode: string;
  rpcUrlSyncingNode: string;
  adminRpcUrlSyncingNode: string;

  // State file (replaces Redis)
  stateFilePath: string;

  // Features
  cleanSlate: boolean;
  sequentialValidation: boolean;
  replayMode: ReplayModeType;
  validateBlockHash: boolean;
  replayBlockRpcEnabled: boolean;
  maxSupportedStarknetVersion?: string;
  mempoolTransactionIntervalMs: number;
  transactionOnlyMaxInflightBlocks: number;
  transactionOnlyBoundaryPollIntervalMs: number;
  transactionOnlyBoundaryTimeoutMs: number;
  transactionOnlyRequireMixedMode: boolean;
  preConfirmedValidationMaxRetries: number;
  preConfirmedValidationRetryDelayMs: number;
}

class Config {
  private static instance: Config;
  private config: EnvironmentConfig;

  private constructor() {
    this.config = this.loadAndValidate();
  }

  public static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  private loadAndValidate(): EnvironmentConfig {
    // Required environment variables
    const requiredVars = [
      "RPC_URL_ORIGINAL_NODE",
      "RPC_URL_SYNCING_NODE",
      "ADMIN_RPC_URL_SYNCING_NODE",
    ];

    const missing = requiredVars.filter((varName) => !process.env[varName]);

    if (missing.length > 0) {
      throw new ConfigurationError(
        `Missing required environment variables: ${missing.join(", ")}`,
      );
    }

    // Validate URL formats
    this.validateUrl(
      process.env.RPC_URL_ORIGINAL_NODE!,
      "RPC_URL_ORIGINAL_NODE",
    );
    this.validateUrl(process.env.RPC_URL_SYNCING_NODE!, "RPC_URL_SYNCING_NODE");
    this.validateUrl(
      process.env.ADMIN_RPC_URL_SYNCING_NODE!,
      "ADMIN_RPC_URL_SYNCING_NODE",
    );

    const maxSupportedStarknetVersion = this.parseOptionalStarknetVersion(
      process.env.MAX_SUPPORTED_STARKNET_VERSION,
      "MAX_SUPPORTED_STARKNET_VERSION",
    );

    const replayMode = this.parseReplayMode(process.env.REPLAY_MODE);
    const config: EnvironmentConfig = {
      // Server
      port: this.parsePort(process.env.PORT),
      nodeEnv: process.env.NODE_ENV || "development",

      // RPC URLs
      rpcUrlOriginalNode: process.env.RPC_URL_ORIGINAL_NODE!,
      rpcUrlSyncingNode: process.env.RPC_URL_SYNCING_NODE!,
      adminRpcUrlSyncingNode: process.env.ADMIN_RPC_URL_SYNCING_NODE!,

      // State file (replaces Redis)
      stateFilePath:
        process.env.STATE_FILE_PATH ||
        path.join(process.cwd(), "sync-state.json"),

      // Features
      cleanSlate: process.env.CLEAN_SLATE?.toLowerCase() === "true",
      sequentialValidation:
        process.env.SEQUENTIAL_VALIDATION?.toLowerCase() === "true",
      replayMode,
      validateBlockHash: resolveBlockHashValidation(
        replayMode,
        process.env.VALIDATE_BLOCK_HASH,
      ),
      replayBlockRpcEnabled:
        process.env.REPLAY_BLOCK_RPC_ENABLED?.toLowerCase() === "true",
      maxSupportedStarknetVersion,
      mempoolTransactionIntervalMs: this.parseNonNegativeInt(
        process.env.MEMPOOL_TRANSACTION_INTERVAL_MS,
        20,
        "MEMPOOL_TRANSACTION_INTERVAL_MS",
      ),
      transactionOnlyMaxInflightBlocks: this.parsePositiveInt(
        process.env.TRANSACTION_ONLY_MAX_INFLIGHT_BLOCKS,
        1,
        "TRANSACTION_ONLY_MAX_INFLIGHT_BLOCKS",
      ),
      transactionOnlyBoundaryPollIntervalMs: this.parsePositiveInt(
        process.env.TRANSACTION_ONLY_BOUNDARY_POLL_INTERVAL_MS,
        100,
        "TRANSACTION_ONLY_BOUNDARY_POLL_INTERVAL_MS",
      ),
      transactionOnlyBoundaryTimeoutMs: this.parsePositiveInt(
        process.env.TRANSACTION_ONLY_BOUNDARY_TIMEOUT_MS,
        30 * 60 * 1000,
        "TRANSACTION_ONLY_BOUNDARY_TIMEOUT_MS",
      ),
      transactionOnlyRequireMixedMode:
        process.env.TRANSACTION_ONLY_REQUIRE_MIXED_MODE?.toLowerCase() ===
        "true",
      preConfirmedValidationMaxRetries: this.parsePositiveInt(
        process.env.PRE_CONFIRMED_VALIDATION_MAX_RETRIES,
        500,
        "PRE_CONFIRMED_VALIDATION_MAX_RETRIES",
      ),
      preConfirmedValidationRetryDelayMs: this.parsePositiveInt(
        process.env.PRE_CONFIRMED_VALIDATION_RETRY_DELAY_MS,
        200,
        "PRE_CONFIRMED_VALIDATION_RETRY_DELAY_MS",
      ),
    };

    if (config.transactionOnlyMaxInflightBlocks > 10) {
      throw new ConfigurationError(
        `Invalid TRANSACTION_ONLY_MAX_INFLIGHT_BLOCKS value: ${config.transactionOnlyMaxInflightBlocks}. Madara supports at most 10 speculative blocks.`,
      );
    }
    if (
      config.replayBlockRpcEnabled &&
      config.replayMode !== ReplayMode.MANAGED_BLOCKS
    ) {
      throw new ConfigurationError(
        "REPLAY_BLOCK_RPC_ENABLED requires REPLAY_MODE=managed_blocks.",
      );
    }

    this.logConfiguration(config);

    return config;
  }

  private validateUrl(url: string, varName: string): void {
    try {
      new URL(url);
    } catch (error) {
      throw new ConfigurationError(`Invalid URL format for ${varName}: ${url}`);
    }
  }

  private parsePort(portStr: string | undefined): number {
    const port = parseInt(portStr || "3000", 10);

    if (isNaN(port) || port < 1 || port > 65535) {
      throw new ConfigurationError(
        `Invalid PORT value: ${portStr}. Must be between 1 and 65535.`,
      );
    }

    return port;
  }

  private parsePositiveInt(
    value: string | undefined,
    defaultValue: number,
    name: string,
  ): number {
    if (value === undefined || value === "") {
      return defaultValue;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new ConfigurationError(
        `Invalid ${name} value: ${value}. Must be a positive integer.`,
      );
    }
    return parsed;
  }

  private parseNonNegativeInt(
    value: string | undefined,
    defaultValue: number,
    name: string,
  ): number {
    if (value === undefined || value === "") {
      return defaultValue;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new ConfigurationError(
        `Invalid ${name} value: ${value}. Must be a non-negative integer.`,
      );
    }
    return parsed;
  }

  private parseReplayMode(mode: string | undefined): ReplayModeType {
    try {
      return parseReplayMode(mode);
    } catch (error) {
      throw new ConfigurationError((error as Error).message);
    }
  }

  private parseOptionalStarknetVersion(
    version: string | undefined,
    varName: string,
  ): string | undefined {
    if (!version) {
      return undefined;
    }

    try {
      return normalizeStarknetVersion(version);
    } catch {
      throw new ConfigurationError(
        `Invalid ${varName} value: ${version}. Expected a dotted numeric Starknet version such as 0.14.1.`,
      );
    }
  }

  private logConfiguration(config: EnvironmentConfig): void {
    logger.info("📋 Configuration loaded:");
    logger.info(`  • Environment: ${config.nodeEnv}`);
    logger.info(`  • Port: ${config.port}`);
    logger.info(
      `  • Original Node: ${this.maskUrl(config.rpcUrlOriginalNode)}`,
    );
    logger.info(`  • Syncing Node: ${this.maskUrl(config.rpcUrlSyncingNode)}`);
    logger.info(
      `  • Admin RPC: ${this.maskUrl(config.adminRpcUrlSyncingNode)}`,
    );
    logger.info(`  • State File: ${config.stateFilePath}`);
    logger.info(
      `  • Clean Slate: ${config.cleanSlate ? "ENABLED" : "disabled"}`,
    );
    logger.info(
      `  • Sequential Validation: ${
        config.sequentialValidation ? "ENABLED" : "disabled"
      }`,
    );
    logger.info(`  • Replay Mode: ${config.replayMode}`);
    logger.info(
      `  • Validate Block Hash: ${config.validateBlockHash ? "ENABLED" : "disabled"}`,
    );
    logger.info(
      `  • Replay Block RPC: ${config.replayBlockRpcEnabled ? "ENABLED" : "disabled"}`,
    );
    logger.info(
      `  • Max Supported Starknet Version: ${
        config.maxSupportedStarknetVersion || "not set"
      }`,
    );
    logger.info(
      `  • Mempool Transaction Interval: ${config.mempoolTransactionIntervalMs}ms`,
    );
    logger.info(
      `  • Transaction-only Max Inflight Blocks: ${config.transactionOnlyMaxInflightBlocks}`,
    );
    logger.info(
      `  • Transaction-only Boundary Poll Interval: ${config.transactionOnlyBoundaryPollIntervalMs}ms`,
    );
    logger.info(
      `  • Transaction-only Boundary Timeout: ${config.transactionOnlyBoundaryTimeoutMs}ms`,
    );
    logger.info(
      `  • Transaction-only Require Mixed Mode: ${
        config.transactionOnlyRequireMixedMode ? "ENABLED" : "disabled"
      }`,
    );
    logger.info(
      `  • Pre-confirmed Validation: ${config.preConfirmedValidationMaxRetries} retries @ ${config.preConfirmedValidationRetryDelayMs}ms`,
    );

    // OpenTelemetry Configuration
    const otelEnabled = process.env.OTEL_ENABLED !== "false";
    const otelEndpoint =
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
    const otelInterval = process.env.OTEL_EXPORT_INTERVAL_MS || "30000";
    const otelServiceName =
      process.env.OTEL_SERVICE_NAME || "transaction-replay-service";

    logger.info(`  • OTEL Enabled: ${otelEnabled ? "YES" : "NO"}`);
    if (otelEnabled) {
      logger.info(`  • OTEL Service Name: ${otelServiceName}`);
      logger.info(`  • OTEL Endpoint: ${otelEndpoint}`);
      logger.info(`  • OTEL Export Interval: ${otelInterval}ms`);
    }
  }

  private maskUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      if (urlObj.password) {
        urlObj.password = "****";
      }
      return urlObj.toString();
    } catch {
      return "****";
    }
  }

  // Getters
  public get port(): number {
    return this.config.port;
  }

  public get nodeEnv(): string {
    return this.config.nodeEnv;
  }

  public get rpcUrlOriginalNode(): string {
    return this.config.rpcUrlOriginalNode;
  }

  public get rpcUrlSyncingNode(): string {
    return this.config.rpcUrlSyncingNode;
  }

  public get adminRpcUrlSyncingNode(): string {
    return this.config.adminRpcUrlSyncingNode;
  }

  public get stateFilePath(): string {
    return this.config.stateFilePath;
  }

  public get cleanSlate(): boolean {
    return this.config.cleanSlate;
  }

  public get sequentialValidation(): boolean {
    return this.config.sequentialValidation;
  }

  public get replayMode(): ReplayModeType {
    return this.config.replayMode;
  }

  public get isTransactionOnlyReplay(): boolean {
    return isTransactionReplayMode(this.config.replayMode);
  }

  public get isMempoolReplay(): boolean {
    return isMempoolReplayMode(this.config.replayMode);
  }

  public get shouldValidateBlockHash(): boolean {
    return this.config.validateBlockHash;
  }

  public get replayBlockRpcEnabled(): boolean {
    return this.config.replayBlockRpcEnabled;
  }

  public get maxSupportedStarknetVersion(): string | undefined {
    return this.config.maxSupportedStarknetVersion;
  }

  public get mempoolTransactionIntervalMs(): number {
    return this.config.mempoolTransactionIntervalMs;
  }

  public get transactionOnlyMaxInflightBlocks(): number {
    return this.config.transactionOnlyMaxInflightBlocks;
  }

  public get transactionOnlyBoundaryPollIntervalMs(): number {
    return this.config.transactionOnlyBoundaryPollIntervalMs;
  }

  public get transactionOnlyBoundaryTimeoutMs(): number {
    return this.config.transactionOnlyBoundaryTimeoutMs;
  }

  public get transactionOnlyRequireMixedMode(): boolean {
    return this.config.transactionOnlyRequireMixedMode;
  }

  public get preConfirmedValidationMaxRetries(): number {
    return this.config.preConfirmedValidationMaxRetries;
  }

  public get preConfirmedValidationRetryDelayMs(): number {
    return this.config.preConfirmedValidationRetryDelayMs;
  }

  public get isDevelopment(): boolean {
    return this.config.nodeEnv === "development";
  }

  public get isProduction(): boolean {
    return this.config.nodeEnv === "production";
  }
}

// Export singleton instance
export const config = Config.getInstance();
