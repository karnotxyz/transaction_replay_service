import dotenv from "dotenv";
import path from "path";
import logger from "./logger.js";

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

  // Replay pipeline
  maxInflightBlocks: number;
  validatorPollIntervalMs: number;
  validatorCloseTimeoutMs: number;
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
        `Missing required environment variables: ${missing.join(", ")}`
      );
    }

    // Validate URL formats
    this.validateUrl(
      process.env.RPC_URL_ORIGINAL_NODE!,
      "RPC_URL_ORIGINAL_NODE"
    );
    this.validateUrl(process.env.RPC_URL_SYNCING_NODE!, "RPC_URL_SYNCING_NODE");
    this.validateUrl(
      process.env.ADMIN_RPC_URL_SYNCING_NODE!,
      "ADMIN_RPC_URL_SYNCING_NODE"
    );

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

      // Replay pipeline
      maxInflightBlocks: this.parsePositiveInt(
        process.env.MAX_INFLIGHT_BLOCKS,
        15,
        "MAX_INFLIGHT_BLOCKS"
      ),
      validatorPollIntervalMs: this.parsePositiveInt(
        process.env.VALIDATOR_POLL_INTERVAL_MS,
        2000,
        "VALIDATOR_POLL_INTERVAL_MS"
      ),
      validatorCloseTimeoutMs: this.parsePositiveInt(
        process.env.VALIDATOR_CLOSE_TIMEOUT_MS,
        15 * 60 * 1000,
        "VALIDATOR_CLOSE_TIMEOUT_MS"
      ),
    };

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
        `Invalid PORT value: ${portStr}. Must be between 1 and 65535.`
      );
    }

    return port;
  }

  private parsePositiveInt(
    value: string | undefined,
    defaultValue: number,
    name: string
  ): number {
    if (value === undefined || value === "") {
      return defaultValue;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ConfigurationError(
        `Invalid ${name} value: ${value}. Must be a positive integer.`
      );
    }

    return parsed;
  }

  private logConfiguration(config: EnvironmentConfig): void {
    logger.info("📋 Configuration loaded:");
    logger.info(`  • Environment: ${config.nodeEnv}`);
    logger.info(`  • Port: ${config.port}`);
    logger.info(
      `  • Original Node: ${this.maskUrl(config.rpcUrlOriginalNode)}`
    );
    logger.info(`  • Syncing Node: ${this.maskUrl(config.rpcUrlSyncingNode)}`);
    logger.info(
      `  • Admin RPC: ${this.maskUrl(config.adminRpcUrlSyncingNode)}`
    );
    logger.info(`  • State File: ${config.stateFilePath}`);
    logger.info(
      `  • Clean Slate: ${config.cleanSlate ? "ENABLED" : "disabled"}`
    );
    logger.info(`  • Max Inflight Blocks: ${config.maxInflightBlocks}`);
    logger.info(
      `  • Validator Poll Interval: ${config.validatorPollIntervalMs}ms`
    );
    logger.info(
      `  • Validator Close Timeout: ${config.validatorCloseTimeoutMs}ms`
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

  public get maxInflightBlocks(): number {
    return this.config.maxInflightBlocks;
  }

  public get validatorPollIntervalMs(): number {
    return this.config.validatorPollIntervalMs;
  }

  public get validatorCloseTimeoutMs(): number {
    return this.config.validatorCloseTimeoutMs;
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
