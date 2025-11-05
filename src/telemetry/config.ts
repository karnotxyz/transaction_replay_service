import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import {
  PeriodicExportingMetricReader,
  MeterProvider,
} from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import logger from "../logger.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read package.json for version
let serviceVersion = "1.0.0";
try {
  const packageJsonPath = path.join(__dirname, "../../package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  serviceVersion = packageJson.version;
} catch (error) {
  logger.warn("Failed to read service version from package.json", { error });
}

export interface TelemetryConfig {
  enabled: boolean;
  otlpEndpoint: string;
  exportIntervalMs: number;
  environment: string;
}

export const telemetryConfig: TelemetryConfig = {
  enabled: process.env.OTEL_ENABLED !== "false", // Enabled by default
  otlpEndpoint:
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
  exportIntervalMs: parseInt(
    process.env.OTEL_EXPORT_INTERVAL_MS || "30000",
    10,
  ),
  environment:
    process.env.DEPLOYMENT_ENVIRONMENT || process.env.NODE_ENV || "development",
};

let sdk: NodeSDK | null = null;

export function initializeTelemetry(): NodeSDK | null {
  if (!telemetryConfig.enabled) {
    logger.info("OpenTelemetry is disabled");
    return null;
  }

  try {
    // Create resource with service information
    const resource = resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: "transaction-replay-service",
      [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: telemetryConfig.environment,
    });

    // Configure OTLP Metric Exporter
    const metricExporter = new OTLPMetricExporter({
      url: `${telemetryConfig.otlpEndpoint}/v1/metrics`,
      headers: {},
      concurrencyLimit: 1,
    });

    // Configure Metric Reader
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: telemetryConfig.exportIntervalMs,
    });

    // Initialize SDK
    sdk = new NodeSDK({
      resource,
      metricReader,
    });

    sdk.start();

    logger.info("OpenTelemetry initialized successfully", {
      endpoint: telemetryConfig.otlpEndpoint,
      environment: telemetryConfig.environment,
      exportInterval: telemetryConfig.exportIntervalMs,
      version: serviceVersion,
    });

    return sdk;
  } catch (error) {
    logger.error("Failed to initialize OpenTelemetry", { error });
    return null;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
      logger.info("OpenTelemetry shut down successfully");
    } catch (error) {
      logger.error("Failed to shut down OpenTelemetry", { error });
    }
  }
}

// Graceful shutdown handlers
process.on("SIGTERM", async () => {
  await shutdownTelemetry();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await shutdownTelemetry();
  process.exit(0);
});
