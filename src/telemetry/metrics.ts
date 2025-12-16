import { metrics } from "@opentelemetry/api";
import { Counter, Gauge, Histogram, ObservableGauge } from "@opentelemetry/api";
import logger from "../logger.js";

// This file uses a lazy initialization pattern to ensure metrics are created
// AFTER the OpenTelemetry SDK's MeterProvider is registered

let _metricsInitialized = false;

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

function initializeMetrics(): void {
  if (_metricsInitialized) return;

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

  _metricsInitialized = true;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function recordBlockProcessingDuration(
  operation: string,
  durationSeconds: number,
): void {
  initializeMetrics();
  _blockProcessingDurationHistogram.record(durationSeconds, { operation });
}

export function incrementBlocksProcessed(): void {
  initializeMetrics();
  _blocksProcessedCounter.add(1, { status: "processed" });
}

export function recordBlockStatus(
  status: "success" | "failed" | "hash_mismatch",
): void {
  initializeMetrics();
  _blockStatusCounter.add(1, { status });
}

export function updateCurrentBlock(blockNumber: number): void {
  initializeMetrics();
  _currentBlockGauge.record(blockNumber, { node: "processing" });
}

export function updateOriginalNodeBlockNumber(blockNumber: number): void {
  initializeMetrics();
  _originalNodeBlockNumberGauge.record(blockNumber, { node: "original" });
}

export function updateSyncingNodeBlockNumber(blockNumber: number): void {
  initializeMetrics();
  _syncingNodeBlockNumberGauge.record(blockNumber, { node: "syncing" });
}

export function incrementTransactionsProcessed(
  txType: string,
  txVersion: string,
): void {
  initializeMetrics();
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
  initializeMetrics();
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
  initializeMetrics();
  _transactionProcessingDurationHistogram.record(durationSeconds, {
    tx_type: txType,
    tx_version: txVersion,
  });
}

export function incrementTransactionReceiptRetries(txType: string): void {
  initializeMetrics();
  _transactionReceiptRetriesCounter.add(1, { tx_type: txType });
}

export function updateActiveSyncProcesses(
  syncMode: "sync",
  count: number,
): void {
  initializeMetrics();
  _activeSyncProcessesGauge.record(count, { sync_mode: syncMode });
}

export function updateSyncProgress(
  processId: string,
  percentage: number,
): void {
  initializeMetrics();
  _syncProgressGauge.record(percentage, { process_id: processId });
}

export function updateSyncBacklog(blocks: number): void {
  initializeMetrics();
  _syncBacklogGauge.record(blocks, { metric: "backlog" });
}

export function updateThroughput(
  blocksPerSecond: number,
  txsPerSecond: number,
): void {
  initializeMetrics();
  _blocksPerSecondGauge.record(blocksPerSecond, { metric: "blocks_rate" });
  _transactionsPerSecondGauge.record(txsPerSecond, { metric: "txs_rate" });
}

export function updateMadaraHealthStatus(isHealthy: boolean): void {
  initializeMetrics();
  _madaraHealthStatusGauge.record(isHealthy ? 1 : 0, { service: "madara" });
}

export function incrementMadaraRecoveryEvents(): void {
  initializeMetrics();
  _madaraRecoveryCounter.add(1, { event: "recovery" });
}

export function recordMadaraDowntime(durationSeconds: number): void {
  initializeMetrics();
  _madaraDowntimeHistogram.record(durationSeconds, { event: "downtime" });
}

export function incrementErrors(errorType: string, operation: string): void {
  initializeMetrics();
  _errorCounter.add(1, { error_type: errorType, operation });
}

export function recordHttpRequest(
  method: string,
  endpoint: string,
  statusCode: number,
  durationSeconds: number,
): void {
  initializeMetrics();
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
  initializeMetrics();
  _probeChecksCounter.add(1, { result });
}

export function incrementProbeNewBlocks(count: number): void {
  initializeMetrics();
  _probeNewBlocksCounter.add(count);
}

export function startTimer(): () => number {
  const startTime = Date.now();
  return () => (Date.now() - startTime) / 1000;
}
