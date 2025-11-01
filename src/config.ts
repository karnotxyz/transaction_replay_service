import dotenv from "dotenv";
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

  // Redis
  redisUrl: string;

  // Features
  cleanSlate: boolean;

  // Network Configuration
  networkEnabled: boolean;
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

    const config: EnvironmentConfig = {
      // Server
      port: this.parsePort(process.env.PORT),
      nodeEnv: process.env.NODE_ENV || "development",

      // RPC URLs
      rpcUrlOriginalNode: process.env.RPC_URL_ORIGINAL_NODE!,
      rpcUrlSyncingNode: process.env.RPC_URL_SYNCING_NODE!,
      adminRpcUrlSyncingNode: process.env.ADMIN_RPC_URL_SYNCING_NODE!,

      // Redis
      redisUrl: process.env.REDIS_URL || "redis://localhost:6379",

      // Features
      cleanSlate: process.env.CLEAN_SLATE?.toLowerCase() === "true",

      // Network
      networkEnabled: process.env.NETWORK_ENABLED?.toLowerCase() !== "false",
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
        `Invalid PORT value: ${portStr}. Must be between 1 and 65535.`,
      );
    }

    return port;
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
    logger.info(`  • Redis: ${this.maskUrl(config.redisUrl)}`);
    logger.info(
      `  • Clean Slate: ${config.cleanSlate ? "ENABLED" : "disabled"}`,
    );
    logger.info(
      `  • Network: ${config.networkEnabled ? "enabled" : "disabled"}`,
    );
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

  public get redisUrl(): string {
    return this.config.redisUrl;
  }

  public get cleanSlate(): boolean {
    return this.config.cleanSlate;
  }

  public get networkEnabled(): boolean {
    return this.config.networkEnabled;
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
