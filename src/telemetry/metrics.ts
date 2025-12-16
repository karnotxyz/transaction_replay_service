import { metrics } from "@opentelemetry/api";
import { Counter, Gauge, Histogram, ObservableGauge } from "@opentelemetry/api";
import { telemetryConfig } from "./config.js";

// This file uses a lazy initialization pattern to ensure metrics are created
// AFTER the OpenTelemetry SDK's MeterProvider is registered
// When OTEL is disabled, all metric operations become no-ops

let _metricsInitialized = false;
let _metricsEnabled = false;

// Private metric instances
let _blocksProcessedCounter: Counter;
let _blockStatusCounter: Counter;
let _blockProcessingDurationHistogram: Histogram;
let _currentBlockGauge: Gauge;
let _originalNodeBlockNumberGauge: Gauge;
let _syncingNodeBlockNumberGauge: Gauge;
let _transactionsProcessedCounter: Counter;
let _transactionStatusCounter: Counter;
let _transactionProcessingDurationHistogram: Histogram;
let _transactionReceiptRetriesCounter: Counter;
let _activeSyncProcessesGauge: Gauge;
let _syncProgressGauge: Gauge;
let _syncBacklogGauge: Gauge;
let _blocksPerSecondGauge: Gauge;
let _transactionsPerSecondGauge: Gauge;
let _madaraHealthStatusGauge: Gauge;
let _madaraRecoveryCounter: Counter;
let _madaraDowntimeHistogram: Histogram;
let _errorCounter: Counter;
let _httpRequestsCounter: Counter;
let _httpRequestDurationHistogram: Histogram;
let _probeChecksCounter: Counter;
let _probeNewBlocksCounter: Counter;
let _processUptimeGauge: ObservableGauge;

function initializeMetrics(): boolean {
  if (_metricsInitialized) return _metricsEnabled;

  _metricsInitialized = true;
  _metricsEnabled = telemetryConfig.enabled;

  // Skip metric initialization if OTEL is disabled
  if (!_metricsEnabled) {
    return false;
  }

  const meter = metrics.getMeter("transaction-replay-service");

  // Block metrics
  _blocksProcessedCounter = meter.createCounter(
    "replay.blocks.processed_total",
    {
      description: "Total number of blocks processed",
      unit: "1",
    },
  );

  _blockStatusCounter = meter.createCounter("replay.blocks.status_total", {
    description: "Block processing status counts",
    unit: "1",
  });

  _blockProcessingDurationHistogram = meter.createHistogram(
    "replay.block.processing_duration_seconds",
    {
      description: "Duration of block processing operations",
      unit: "s",
    },
  );

  _currentBlockGauge = meter.createGauge("replay.blocks.current_processing", {
    description: "Current block number being processed",
    unit: "1",
  });

  _originalNodeBlockNumberGauge = meter.createGauge(
    "replay.original_node.current_block_number",
    {
      description: "Latest block number on the original/source node",
      unit: "1",
    },
  );

  _syncingNodeBlockNumberGauge = meter.createGauge(
    "replay.syncing_node.current_block_number",
    {
      description: "Latest block number on the syncing/Madara node",
      unit: "1",
    },
  );

  // Transaction metrics
  _transactionsProcessedCounter = meter.createCounter(
    "replay.transactions.processed_total",
    {
      description: "Total number of transactions processed by type and version",
      unit: "1",
    },
  );

  _transactionStatusCounter = meter.createCounter(
    "replay.transactions.status_total",
    {
      description: "Transaction processing status counts",
      unit: "1",
    },
  );

  _transactionProcessingDurationHistogram = meter.createHistogram(
    "replay.transactions.processing_duration_seconds",
    {
      description: "Duration of transaction processing",
      unit: "s",
    },
  );

  _transactionReceiptRetriesCounter = meter.createCounter(
    "replay.transactions.receipt_retries_total",
    {
      description: "Number of retries for transaction receipt validation",
      unit: "1",
    },
  );

  // Sync metrics
  _activeSyncProcessesGauge = meter.createGauge(
    "replay.sync.active_processes",
    {
      description: "Number of active sync processes by mode",
      unit: "1",
    },
  );

  _syncProgressGauge = meter.createGauge("replay.sync.progress_percent", {
    description: "Sync progress as percentage",
    unit: "%",
  });

  _syncBacklogGauge = meter.createGauge("replay.sync.backlog_blocks", {
    description: "Number of blocks behind the original node",
    unit: "1",
  });

  // Throughput metrics
  _blocksPerSecondGauge = meter.createGauge(
    "replay.throughput.blocks_per_second",
    {
      description: "Current blocks processing rate",
      unit: "blocks/s",
    },
  );

  _transactionsPerSecondGauge = meter.createGauge(
    "replay.throughput.transactions_per_second",
    {
      description: "Current transactions processing rate",
      unit: "txs/s",
    },
  );

  // Madara health metrics
  _madaraHealthStatusGauge = meter.createGauge("replay.madara.health_status", {
    description: "Madara node health status (1=healthy, 0=down)",
    unit: "1",
  });

  _madaraRecoveryCounter = meter.createCounter(
    "replay.madara.recovery_events_total",
    {
      description: "Number of Madara node recovery events",
      unit: "1",
    },
  );

  _madaraDowntimeHistogram = meter.createHistogram(
    "replay.madara.downtime_duration_seconds",
    {
      description: "Duration of Madara node downtime",
      unit: "s",
    },
  );

  // Error metrics
  _errorCounter = meter.createCounter("replay.errors.total", {
    description: "Total number of errors by type and operation",
    unit: "1",
  });

  // HTTP metrics
  _httpRequestsCounter = meter.createCounter("replay.http.requests_total", {
    description: "Total number of HTTP requests",
    unit: "1",
  });

  _httpRequestDurationHistogram = meter.createHistogram(
    "replay.http.request_duration_seconds",
    {
      description: "Duration of HTTP requests",
      unit: "s",
    },
  );

  // Probe metrics
  _probeChecksCounter = meter.createCounter("replay.probe.checks_total", {
    description: "Number of probe checks for new blocks",
    unit: "1",
  });

  _probeNewBlocksCounter = meter.createCounter(
    "replay.probe.new_blocks_detected_total",
    {
      description: "Number of new blocks detected by probe",
      unit: "1",
    },
  );

  // System metrics
  _processUptimeGauge = meter.createObservableGauge(
    "replay.process.uptime_seconds",
    {
      description: "Process uptime in seconds",
      unit: "s",
    },
  );

  _processUptimeGauge.addCallback((observableResult) => {
    observableResult.observe(process.uptime());
  });

  return true;
}

// ============================================================================
// HELPER FUNCTIONS
// All functions are no-ops when OTEL is disabled
// ============================================================================

export function recordBlockProcessingDuration(
  operation: string,
  durationSeconds: number,
): void {
  if (!initializeMetrics()) return;
  _blockProcessingDurationHistogram.record(durationSeconds, { operation });
}

export function incrementBlocksProcessed(): void {
  if (!initializeMetrics()) return;
  _blocksProcessedCounter.add(1, { status: "processed" });
}

export function recordBlockStatus(
  status: "success" | "failed" | "hash_mismatch",
): void {
  if (!initializeMetrics()) return;
  _blockStatusCounter.add(1, { status });
}

export function updateCurrentBlock(blockNumber: number): void {
  if (!initializeMetrics()) return;
  _currentBlockGauge.record(blockNumber, { node: "processing" });
}

export function updateOriginalNodeBlockNumber(blockNumber: number): void {
  if (!initializeMetrics()) return;
  _originalNodeBlockNumberGauge.record(blockNumber, { node: "original" });
}

export function updateSyncingNodeBlockNumber(blockNumber: number): void {
  if (!initializeMetrics()) return;
  _syncingNodeBlockNumberGauge.record(blockNumber, { node: "syncing" });
}

export function incrementTransactionsProcessed(
  txType: string,
  txVersion: string,
): void {
  if (!initializeMetrics()) return;
  _transactionsProcessedCounter.add(1, {
    tx_type: txType,
    tx_version: txVersion,
  });
}

export function recordTransactionStatus(
  txType: string,
  txVersion: string,
  status: "success" | "failed" | "retried",
): void {
  if (!initializeMetrics()) return;
  _transactionStatusCounter.add(1, {
    tx_type: txType,
    tx_version: txVersion,
    status,
  });
}

export function recordTransactionProcessingDuration(
  txType: string,
  txVersion: string,
  durationSeconds: number,
): void {
  if (!initializeMetrics()) return;
  _transactionProcessingDurationHistogram.record(durationSeconds, {
    tx_type: txType,
    tx_version: txVersion,
  });
}

export function incrementTransactionReceiptRetries(txType: string): void {
  if (!initializeMetrics()) return;
  _transactionReceiptRetriesCounter.add(1, { tx_type: txType });
}

export function updateActiveSyncProcesses(
  syncMode: "sync",
  count: number,
): void {
  if (!initializeMetrics()) return;
  _activeSyncProcessesGauge.record(count, { sync_mode: syncMode });
}

export function updateSyncProgress(
  processId: string,
  percentage: number,
): void {
  if (!initializeMetrics()) return;
  _syncProgressGauge.record(percentage, { process_id: processId });
}

export function updateSyncBacklog(blocks: number): void {
  if (!initializeMetrics()) return;
  _syncBacklogGauge.record(blocks, { metric: "backlog" });
}

export function updateThroughput(
  blocksPerSecond: number,
  txsPerSecond: number,
): void {
  if (!initializeMetrics()) return;
  _blocksPerSecondGauge.record(blocksPerSecond, { metric: "blocks_rate" });
  _transactionsPerSecondGauge.record(txsPerSecond, { metric: "txs_rate" });
}

export function updateMadaraHealthStatus(isHealthy: boolean): void {
  if (!initializeMetrics()) return;
  _madaraHealthStatusGauge.record(isHealthy ? 1 : 0, { service: "madara" });
}

export function incrementMadaraRecoveryEvents(): void {
  if (!initializeMetrics()) return;
  _madaraRecoveryCounter.add(1, { event: "recovery" });
}

export function recordMadaraDowntime(durationSeconds: number): void {
  if (!initializeMetrics()) return;
  _madaraDowntimeHistogram.record(durationSeconds, { event: "downtime" });
}

export function incrementErrors(errorType: string, operation: string): void {
  if (!initializeMetrics()) return;
  _errorCounter.add(1, { error_type: errorType, operation });
}

export function recordHttpRequest(
  method: string,
  endpoint: string,
  statusCode: number,
  durationSeconds: number,
): void {
  if (!initializeMetrics()) return;
  _httpRequestsCounter.add(1, {
    method,
    endpoint,
    status_code: statusCode.toString(),
  });
  _httpRequestDurationHistogram.record(durationSeconds, { method, endpoint });
}

export function incrementProbeChecks(
  result: "new_blocks" | "no_change" | "error",
): void {
  if (!initializeMetrics()) return;
  _probeChecksCounter.add(1, { result });
}

export function incrementProbeNewBlocks(count: number): void {
  if (!initializeMetrics()) return;
  _probeNewBlocksCounter.add(count);
}

export function startTimer(): () => number {
  const startTime = Date.now();
  return () => (Date.now() - startTime) / 1000;
}
