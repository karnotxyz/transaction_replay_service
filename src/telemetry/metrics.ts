import { metrics } from '@opentelemetry/api';
import {
  Counter,
  Gauge,
  Histogram,
  ObservableGauge,
  MetricOptions,
} from '@opentelemetry/api';

// Get the meter for this service
const meter = metrics.getMeter('transaction-replay-service');

// ============================================================================
// BLOCK METRICS
// ============================================================================

// Counter: Total blocks processed
export const blocksProcessedCounter: Counter = meter.createCounter(
  'replay.blocks.processed_total',
  {
    description: 'Total number of blocks processed',
    unit: '1',
  }
);

// Counter: Block processing status
export const blockStatusCounter: Counter = meter.createCounter(
  'replay.blocks.status_total',
  {
    description: 'Block processing status counts',
    unit: '1',
  }
);

// Histogram: Block processing duration
export const blockProcessingDurationHistogram: Histogram = meter.createHistogram(
  'replay.block.processing_duration_seconds',
  {
    description: 'Duration of block processing operations',
    unit: 's',
  }
);

// Gauge: Current block being processed
export const currentBlockGauge: Gauge = meter.createGauge(
  'replay.blocks.current_processing',
  {
    description: 'Current block number being processed',
    unit: '1',
  }
);

// Gauge: Original node current block number
export const originalNodeBlockNumberGauge: Gauge = meter.createGauge(
  'replay.original_node.current_block_number',
  {
    description: 'Latest block number on the original/source node',
    unit: '1',
  }
);

// Gauge: Syncing node current block number
export const syncingNodeBlockNumberGauge: Gauge = meter.createGauge(
  'replay.syncing_node.current_block_number',
  {
    description: 'Latest block number on the syncing/Madara node',
    unit: '1',
  }
);

// ============================================================================
// TRANSACTION METRICS
// ============================================================================

// Counter: Transactions processed by type and version
export const transactionsProcessedCounter: Counter = meter.createCounter(
  'replay.transactions.processed_total',
  {
    description: 'Total number of transactions processed by type and version',
    unit: '1',
  }
);

// Counter: Transaction processing status
export const transactionStatusCounter: Counter = meter.createCounter(
  'replay.transactions.status_total',
  {
    description: 'Transaction processing status counts',
    unit: '1',
  }
);

// Histogram: Transaction processing duration
export const transactionProcessingDurationHistogram: Histogram = meter.createHistogram(
  'replay.transactions.processing_duration_seconds',
  {
    description: 'Duration of transaction processing',
    unit: 's',
  }
);

// Counter: Transaction receipt validation retries
export const transactionReceiptRetriesCounter: Counter = meter.createCounter(
  'replay.transactions.receipt_retries_total',
  {
    description: 'Number of retries for transaction receipt validation',
    unit: '1',
  }
);

// ============================================================================
// SYNC PROCESS METRICS
// ============================================================================

// Gauge: Active sync processes
export const activeSyncProcessesGauge: Gauge = meter.createGauge(
  'replay.sync.active_processes',
  {
    description: 'Number of active sync processes by mode',
    unit: '1',
  }
);

// Gauge: Sync progress percentage
export const syncProgressGauge: Gauge = meter.createGauge(
  'replay.sync.progress_percent',
  {
    description: 'Sync progress as percentage',
    unit: '%',
  }
);

// Gauge: Sync backlog (blocks behind)
export const syncBacklogGauge: Gauge = meter.createGauge(
  'replay.sync.backlog_blocks',
  {
    description: 'Number of blocks behind the original node',
    unit: '1',
  }
);

// ============================================================================
// THROUGHPUT METRICS
// ============================================================================

// Gauge: Blocks per second
export const blocksPerSecondGauge: Gauge = meter.createGauge(
  'replay.throughput.blocks_per_second',
  {
    description: 'Current blocks processing rate',
    unit: 'blocks/s',
  }
);

// Gauge: Transactions per second
export const transactionsPerSecondGauge: Gauge = meter.createGauge(
  'replay.throughput.transactions_per_second',
  {
    description: 'Current transactions processing rate',
    unit: 'txs/s',
  }
);

// ============================================================================
// MADARA HEALTH METRICS
// ============================================================================

// Gauge: Madara health status
export const madaraHealthStatusGauge: Gauge = meter.createGauge(
  'replay.madara.health_status',
  {
    description: 'Madara node health status (1=healthy, 0=down)',
    unit: '1',
  }
);

// Counter: Madara recovery events
export const madaraRecoveryCounter: Counter = meter.createCounter(
  'replay.madara.recovery_events_total',
  {
    description: 'Number of Madara node recovery events',
    unit: '1',
  }
);

// Histogram: Madara downtime duration
export const madaraDowntimeHistogram: Histogram = meter.createHistogram(
  'replay.madara.downtime_duration_seconds',
  {
    description: 'Duration of Madara node downtime',
    unit: 's',
  }
);

// ============================================================================
// ERROR METRICS
// ============================================================================

// Counter: Errors by type
export const errorCounter: Counter = meter.createCounter(
  'replay.errors.total',
  {
    description: 'Total number of errors by type and operation',
    unit: '1',
  }
);

// ============================================================================
// REDIS METRICS
// ============================================================================

// Gauge: Redis connection status
export const redisConnectionStatusGauge: Gauge = meter.createGauge(
  'replay.redis.connection_status',
  {
    description: 'Redis connection status (1=connected, 0=disconnected)',
    unit: '1',
  }
);

// ============================================================================
// HTTP METRICS
// ============================================================================

// Counter: HTTP requests
export const httpRequestsCounter: Counter = meter.createCounter(
  'replay.http.requests_total',
  {
    description: 'Total number of HTTP requests',
    unit: '1',
  }
);

// Histogram: HTTP request duration
export const httpRequestDurationHistogram: Histogram = meter.createHistogram(
  'replay.http.request_duration_seconds',
  {
    description: 'Duration of HTTP requests',
    unit: 's',
  }
);

// ============================================================================
// PROBE METRICS (Continuous Sync)
// ============================================================================

// Counter: Probe checks
export const probeChecksCounter: Counter = meter.createCounter(
  'replay.probe.checks_total',
  {
    description: 'Number of probe checks for new blocks',
    unit: '1',
  }
);

// Counter: New blocks detected by probe
export const probeNewBlocksCounter: Counter = meter.createCounter(
  'replay.probe.new_blocks_detected_total',
  {
    description: 'Number of new blocks detected by probe',
    unit: '1',
  }
);

// ============================================================================
// SYSTEM METRICS
// ============================================================================

// Observable Gauge: Process uptime
export const processUptimeGauge: ObservableGauge = meter.createObservableGauge(
  'replay.process.uptime_seconds',
  {
    description: 'Process uptime in seconds',
    unit: 's',
  }
);

// Register callback for process uptime
processUptimeGauge.addCallback((observableResult) => {
  observableResult.observe(process.uptime());
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Record block processing duration
 */
export function recordBlockProcessingDuration(
  operation: string,
  durationSeconds: number
): void {
  blockProcessingDurationHistogram.record(durationSeconds, { operation });
}

/**
 * Increment blocks processed counter
 */
export function incrementBlocksProcessed(): void {
  blocksProcessedCounter.add(1);
}

/**
 * Record block status
 */
export function recordBlockStatus(status: 'success' | 'failed' | 'hash_mismatch'): void {
  blockStatusCounter.add(1, { status });
}

/**
 * Update current block being processed
 */
export function updateCurrentBlock(blockNumber: number): void {
  currentBlockGauge.record(blockNumber);
}

/**
 * Update original node block number
 */
export function updateOriginalNodeBlockNumber(blockNumber: number): void {
  originalNodeBlockNumberGauge.record(blockNumber);
}

/**
 * Update syncing node block number
 */
export function updateSyncingNodeBlockNumber(blockNumber: number): void {
  syncingNodeBlockNumberGauge.record(blockNumber);
}

/**
 * Increment transactions processed counter
 */
export function incrementTransactionsProcessed(
  txType: string,
  txVersion: string
): void {
  transactionsProcessedCounter.add(1, { tx_type: txType, tx_version: txVersion });
}

/**
 * Record transaction status
 */
export function recordTransactionStatus(
  txType: string,
  txVersion: string,
  status: 'success' | 'failed' | 'retried'
): void {
  transactionStatusCounter.add(1, { tx_type: txType, tx_version: txVersion, status });
}

/**
 * Record transaction processing duration
 */
export function recordTransactionProcessingDuration(
  txType: string,
  txVersion: string,
  durationSeconds: number
): void {
  transactionProcessingDurationHistogram.record(durationSeconds, {
    tx_type: txType,
    tx_version: txVersion,
  });
}

/**
 * Increment transaction receipt retries
 */
export function incrementTransactionReceiptRetries(txType: string): void {
  transactionReceiptRetriesCounter.add(1, { tx_type: txType });
}

/**
 * Update active sync processes
 */
export function updateActiveSyncProcesses(
  syncMode: 'sequential' | 'snap_sync',
  count: number
): void {
  activeSyncProcessesGauge.record(count, { sync_mode: syncMode });
}

/**
 * Update sync progress percentage
 */
export function updateSyncProgress(processId: string, percentage: number): void {
  syncProgressGauge.record(percentage, { process_id: processId });
}

/**
 * Update sync backlog
 */
export function updateSyncBacklog(blocks: number): void {
  syncBacklogGauge.record(blocks);
}

/**
 * Update throughput metrics
 */
export function updateThroughput(blocksPerSecond: number, txsPerSecond: number): void {
  blocksPerSecondGauge.record(blocksPerSecond);
  transactionsPerSecondGauge.record(txsPerSecond);
}

/**
 * Update Madara health status
 */
export function updateMadaraHealthStatus(isHealthy: boolean): void {
  madaraHealthStatusGauge.record(isHealthy ? 1 : 0);
}

/**
 * Increment Madara recovery events
 */
export function incrementMadaraRecoveryEvents(): void {
  madaraRecoveryCounter.add(1);
}

/**
 * Record Madara downtime duration
 */
export function recordMadaraDowntime(durationSeconds: number): void {
  madaraDowntimeHistogram.record(durationSeconds);
}

/**
 * Increment error counter
 */
export function incrementErrors(errorType: string, operation: string): void {
  errorCounter.add(1, { error_type: errorType, operation });
}

/**
 * Update Redis connection status
 */
export function updateRedisConnectionStatus(isConnected: boolean): void {
  redisConnectionStatusGauge.record(isConnected ? 1 : 0);
}

/**
 * Record HTTP request
 */
export function recordHttpRequest(
  method: string,
  endpoint: string,
  statusCode: number,
  durationSeconds: number
): void {
  httpRequestsCounter.add(1, { method, endpoint, status_code: statusCode.toString() });
  httpRequestDurationHistogram.record(durationSeconds, { method, endpoint });
}

/**
 * Increment probe checks
 */
export function incrementProbeChecks(result: 'new_blocks' | 'no_change' | 'error'): void {
  probeChecksCounter.add(1, { result });
}

/**
 * Increment new blocks detected by probe
 */
export function incrementProbeNewBlocks(count: number): void {
  probeNewBlocksCounter.add(count);
}

/**
 * Timer helper for measuring duration
 */
export function startTimer(): () => number {
  const startTime = Date.now();
  return () => (Date.now() - startTime) / 1000;
}
