import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import {
  PeriodicExportingMetricReader,
  MeterProvider,
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import { metrics } from "@opentelemetry/api";
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
let lastExportTime: number = 0;
let exportSuccessCount: number = 0;
let exportFailureCount: number = 0;

/**
 * Logging wrapper for OTLP Metric Exporter
 * Logs all export attempts and their results
 */
class LoggingMetricExporter implements PushMetricExporter {
  private exporter: OTLPMetricExporter;

  constructor(exporter: OTLPMetricExporter) {
    this.exporter = exporter;
  }

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    const exportStartTime = Date.now();
    const metricCount = this.countMetrics(metrics);

    logger.debug("📤 Attempting to export metrics to OTLP", {
      endpoint: telemetryConfig.otlpEndpoint,
      metricCount,
      timeSinceLastExport: lastExportTime
        ? exportStartTime - lastExportTime
        : 0,
    });

    this.exporter.export(metrics, (result: ExportResult) => {
      const exportDuration = Date.now() - exportStartTime;
      lastExportTime = Date.now();

      if (result.code === ExportResultCode.SUCCESS) {
        exportSuccessCount++;

        // Extract metric names for debugging
        const metricNames: string[] = [];
        for (const scopeMetrics of metrics.scopeMetrics) {
          for (const metric of scopeMetrics.metrics) {
            metricNames.push(metric.descriptor.name);
          }
        }
      } else {
        exportFailureCount++;
        logger.error("❌ Failed to export metrics to OTLP", {
          endpoint: telemetryConfig.otlpEndpoint,
          metricCount,
          durationMs: exportDuration,
          error: result.error?.message || "Unknown error",
          resultCode: result.code,
          totalSuccesses: exportSuccessCount,
          totalFailures: exportFailureCount,
        });
      }

      resultCallback(result);
    });
  }

  async shutdown(): Promise<void> {
    logger.info("🛑 Shutting down OTLP metric exporter", {
      totalSuccesses: exportSuccessCount,
      totalFailures: exportFailureCount,
    });
    return this.exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    logger.debug("🔄 Force flushing metrics");
    return this.exporter.forceFlush();
  }

  /**
   * Count total number of metrics in ResourceMetrics
   */
  private countMetrics(resourceMetrics: ResourceMetrics): number {
    let count = 0;
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      count += scopeMetrics.metrics.length;
    }
    return count;
  }
}

export function initializeTelemetry(): NodeSDK | null {
  if (!telemetryConfig.enabled) {
    logger.info("OpenTelemetry is disabled");
    return null;
  }

  try {
    // Create resource with service information
    const serviceName =
      process.env.OTEL_SERVICE_NAME || "transaction-replay-service";

    const resource = resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: telemetryConfig.environment,
    });

    // Configure OTLP Metric Exporter
    const baseExporter = new OTLPMetricExporter({
      url: `${telemetryConfig.otlpEndpoint}/v1/metrics`,
      headers: {
        "Content-Type": "application/x-protobuf",
      },
      concurrencyLimit: 1,
      timeoutMillis: 10000,
    });

    // Wrap exporter with logging
    const metricExporter = new LoggingMetricExporter(baseExporter);

    logger.info("📊 OTLP Metric Exporter configured", {
      url: `${telemetryConfig.otlpEndpoint}/v1/metrics`,
      exportInterval: `${telemetryConfig.exportIntervalMs}ms`,
      timeout: "10000ms",
    });

    // Configure Metric Reader with error handling
    // exportTimeoutMillis must be <= exportIntervalMillis
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: telemetryConfig.exportIntervalMs,
      exportTimeoutMillis: Math.min(telemetryConfig.exportIntervalMs, 10000),
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
