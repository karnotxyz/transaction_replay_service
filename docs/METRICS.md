# OpenTelemetry Metrics Documentation

This document describes all the metrics exposed by the Transaction Replay Service via OpenTelemetry.

## Table of Contents

1. [Configuration](#configuration)
2. [Block Metrics](#block-metrics)
3. [Transaction Metrics](#transaction-metrics)
4. [Sync Process Metrics](#sync-process-metrics)
5. [Throughput Metrics](#throughput-metrics)
6. [Madara Health Metrics](#madara-health-metrics)
7. [Error Metrics](#error-metrics)
8. [System Metrics](#system-metrics)
9. [HTTP Metrics](#http-metrics)
10. [Probe Metrics](#probe-metrics)
11. [Grafana Dashboard Examples](#grafana-dashboard-examples)

---

## Configuration

### Environment Variables

Add these variables to your `.env` file:

```bash
# OpenTelemetry Configuration
OTEL_ENABLED=true                                    # Enable/disable OpenTelemetry (default: true)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # OTLP collector endpoint
OTEL_EXPORT_INTERVAL_MS=30000                        # Metrics export interval in milliseconds
DEPLOYMENT_ENVIRONMENT=development                    # Environment label (development/staging/production)
```

### OTLP Collector Setup

The service sends metrics via OTLP (OpenTelemetry Protocol) to a collector. You can use:

1. **OpenTelemetry Collector** (recommended)
2. **Grafana Agent**
3. **Grafana Cloud OTLP endpoint**
4. **Any OTLP-compatible backend**

Example OpenTelemetry Collector configuration:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317

exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"

  logging:
    loglevel: debug

service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheus, logging]
```

---

## Block Metrics

### `replay.blocks.processed_total`
**Type:** Counter
**Description:** Total number of blocks successfully processed
**Use Cases:**
- Track overall progress
- Calculate blocks replayed per minute (rate)
- Monitor processing rate over time

**Query Examples:**
```promql
# Blocks per minute
rate(replay_blocks_processed_total[1m]) * 60

# Total blocks processed today
increase(replay_blocks_processed_total[24h])
```

---

### `replay.blocks.status_total`
**Type:** Counter
**Labels:** `status` (success, failed, hash_mismatch)
**Description:** Block processing status counts
**Use Cases:**
- Monitor success/failure rates
- Alert on hash mismatches
- Track error frequency

**Query Examples:**
```promql
# Success rate
rate(replay_blocks_status_total{status="success"}[5m])

# Failure rate
rate(replay_blocks_status_total{status="failed"}[5m])

# Hash mismatch events
increase(replay_blocks_status_total{status="hash_mismatch"}[1h])
```

---

### `replay.block.processing_duration_seconds`
**Type:** Histogram
**Labels:** `operation` (validate, set_header, process_txs, close_block, verify_hash)
**Description:** Duration of block processing operations
**Buckets:** Default histogram buckets
**Use Cases:**
- Identify bottlenecks in block processing
- Monitor performance degradation
- Track p95/p99 latencies

**Query Examples:**
```promql
# Average block processing time
avg(replay_block_processing_duration_seconds)

# P95 latency for transaction processing
histogram_quantile(0.95, rate(replay_block_processing_duration_seconds_bucket{operation="process_txs"}[5m]))

# P99 latency for block validation
histogram_quantile(0.99, rate(replay_block_processing_duration_seconds_bucket{operation="validate"}[5m]))
```

---

### `replay.blocks.current_processing`
**Type:** Gauge
**Description:** Current block number being processed
**Use Cases:**
- Real-time progress monitoring
- Identify stuck processes
- Track current position

**Query Examples:**
```promql
# Current block being processed
replay_blocks_current_processing

# Blocks processed in last hour
replay_blocks_current_processing - (replay_blocks_current_processing offset 1h)
```

---

### `replay.original_node.current_block_number`
**Type:** Gauge
**Description:** Latest block number on the original/source node
**Use Cases:**
- Track source chain progress
- Calculate lag/backlog
- Monitor source availability

---

### `replay.syncing_node.current_block_number`
**Type:** Gauge
**Description:** Latest block number on the syncing/Madara node
**Use Cases:**
- Track destination chain progress
- Calculate sync lag
- Monitor catch-up progress

**Query Examples:**
```promql
# Calculate backlog/lag
replay_original_node_current_block_number - replay_syncing_node_current_block_number

# Blocks behind
(replay_original_node_current_block_number - replay_syncing_node_current_block_number) > 100
```

---

## Transaction Metrics

### `replay.transactions.processed_total`
**Type:** Counter
**Labels:** `tx_type` (INVOKE, DECLARE, DEPLOY_ACCOUNT, L1_HANDLER), `tx_version` (V0, V1, V2, V3)
**Description:** Total number of transactions processed by type and version
**Use Cases:**
- Track transaction type distribution
- Monitor specific transaction versions
- Calculate transaction throughput

**Query Examples:**
```promql
# Total transactions processed
sum(replay_transactions_processed_total)

# Transactions per second
rate(replay_transactions_processed_total[1m])

# Breakdown by transaction type
sum by (tx_type) (rate(replay_transactions_processed_total[5m]))

# INVOKE V3 transactions per minute
rate(replay_transactions_processed_total{tx_type="INVOKE", tx_version="V3"}[1m]) * 60

# Top transaction types
topk(5, sum by (tx_type, tx_version) (replay_transactions_processed_total))
```

---

### `replay.transactions.status_total`
**Type:** Counter
**Labels:** `tx_type`, `tx_version`, `status` (success, failed, retried)
**Description:** Transaction processing status counts
**Use Cases:**
- Monitor transaction success rates
- Track retry patterns
- Alert on high failure rates

**Query Examples:**
```promql
# Transaction success rate
rate(replay_transactions_status_total{status="success"}[5m]) /
rate(replay_transactions_status_total[5m])

# Failed transactions by type
sum by (tx_type) (rate(replay_transactions_status_total{status="failed"}[5m]))
```

---

### `replay.transactions.processing_duration_seconds`
**Type:** Histogram
**Labels:** `tx_type`, `tx_version`
**Description:** Duration of transaction processing (send + receipt validation)
**Use Cases:**
- Monitor transaction latency
- Identify slow transaction types
- Track performance trends

**Query Examples:**
```promql
# Average transaction processing time
avg(replay_transactions_processing_duration_seconds)

# P95 latency by transaction type
histogram_quantile(0.95,
  sum by (tx_type, le) (
    rate(replay_transactions_processing_duration_seconds_bucket[5m])
  )
)

# Slowest transaction types
topk(3,
  histogram_quantile(0.95,
    rate(replay_transactions_processing_duration_seconds_bucket[5m])
  )
)
```

---

### `replay.transactions.receipt_retries_total`
**Type:** Counter
**Labels:** `tx_type`
**Description:** Number of retries for transaction receipt validation
**Use Cases:**
- Monitor receipt validation issues
- Track Madara responsiveness
- Alert on high retry rates

**Query Examples:**
```promql
# Receipt validation retries per minute
rate(replay_transactions_receipt_retries_total[1m]) * 60

# Retries by transaction type
sum by (tx_type) (replay_transactions_receipt_retries_total)
```

---

## Sync Process Metrics

### `replay.sync.active_processes`
**Type:** Gauge
**Labels:** `sync_mode` (sequential, snap_sync)
**Description:** Number of active sync processes by mode
**Use Cases:**
- Monitor active syncs
- Prevent concurrent syncs
- Track sync mode usage

**Query Examples:**
```promql
# Total active processes
sum(replay_sync_active_processes)

# Active sequential syncs
replay_sync_active_processes{sync_mode="sequential"}
```

---

### `replay.sync.progress_percent`
**Type:** Gauge
**Labels:** `process_id`
**Description:** Sync progress as percentage
**Use Cases:**
- Monitor sync completion
- Estimate time remaining
- Track multiple sync processes

**Query Examples:**
```promql
# Current sync progress
replay_sync_progress_percent

# Processes over 50% complete
replay_sync_progress_percent > 50
```

---

### `replay.sync.backlog_blocks`
**Type:** Gauge
**Description:** Number of blocks behind the original node
**Use Cases:**
- Monitor sync lag
- Alert on increasing backlog
- Track catch-up efficiency

**Query Examples:**
```promql
# Current backlog
replay_sync_backlog_blocks

# Alert if backlog exceeds threshold
replay_sync_backlog_blocks > 1000

# Backlog reduction rate
rate(replay_sync_backlog_blocks[5m])
```

---

## Throughput Metrics

### `replay.throughput.blocks_per_second`
**Type:** Gauge
**Description:** Current blocks processing rate
**Use Cases:**
- Monitor processing speed
- Identify performance issues
- Capacity planning

**Query Examples:**
```promql
# Current blocks per second
replay_throughput_blocks_per_second

# Blocks per minute
replay_throughput_blocks_per_second * 60

# Average over 5 minutes
avg_over_time(replay_throughput_blocks_per_second[5m])
```

---

### `replay.throughput.transactions_per_second`
**Type:** Gauge
**Description:** Current transactions processing rate
**Use Cases:**
- Monitor TPS
- Compare with network TPS
- Performance benchmarking

**Query Examples:**
```promql
# Current transactions per second
replay_throughput_transactions_per_second

# Peak TPS in last hour
max_over_time(replay_throughput_transactions_per_second[1h])

# Average TPS over 5 minutes
avg_over_time(replay_throughput_transactions_per_second[5m])
```

---

## Madara Health Metrics

### `replay.madara.health_status`
**Type:** Gauge
**Values:** 1 (healthy), 0 (down)
**Description:** Madara node health status
**Use Cases:**
- Monitor Madara availability
- Alert on downtime
- Track uptime percentage

**Query Examples:**
```promql
# Is Madara healthy?
replay_madara_health_status == 1

# Uptime percentage (last 24h)
avg_over_time(replay_madara_health_status[24h]) * 100

# Alert if Madara is down
replay_madara_health_status == 0
```

---

### `replay.madara.recovery_events_total`
**Type:** Counter
**Description:** Number of Madara node recovery events
**Use Cases:**
- Track failure frequency
- Monitor stability
- Incident analysis

**Query Examples:**
```promql
# Recovery events in last hour
increase(replay_madara_recovery_events_total[1h])

# Recovery rate
rate(replay_madara_recovery_events_total[24h])
```

---

### `replay.madara.downtime_duration_seconds`
**Type:** Histogram
**Description:** Duration of Madara node downtime periods
**Use Cases:**
- Analyze downtime patterns
- Track MTTR (Mean Time To Recovery)
- Capacity planning

**Query Examples:**
```promql
# Average downtime duration
avg(replay_madara_downtime_duration_seconds)

# P95 downtime duration
histogram_quantile(0.95, rate(replay_madara_downtime_duration_seconds_bucket[1h]))

# Total downtime in last 24h
sum(increase(replay_madara_downtime_duration_seconds_sum[24h]))
```

---

## Error Metrics

### `replay.errors.total`
**Type:** Counter
**Labels:** `error_type`, `operation`
**Description:** Total number of errors by type and operation
**Use Cases:**
- Monitor error rates
- Alert on critical errors
- Debug issues

**Query Examples:**
```promql
# Total errors per minute
rate(replay_errors_total[1m]) * 60

# Errors by type
sum by (error_type) (replay_errors_total)

# Top error operations
topk(5, sum by (operation) (replay_errors_total))

# Block hash mismatch errors
replay_errors_total{error_type="block_hash_mismatch"}
```

---

## System Metrics

### `replay.redis.connection_status`
**Type:** Gauge
**Values:** 1 (connected), 0 (disconnected)
**Description:** Redis connection status
**Use Cases:**
- Monitor Redis availability
- Alert on connection loss
- Track connectivity issues

**Query Examples:**
```promql
# Is Redis connected?
replay_redis_connection_status == 1

# Alert if Redis is disconnected
replay_redis_connection_status == 0
```

---

### `replay.process.uptime_seconds`
**Type:** ObservableGauge
**Description:** Process uptime in seconds
**Use Cases:**
- Monitor service restarts
- Track stability
- Incident timeline

**Query Examples:**
```promql
# Current uptime
replay_process_uptime_seconds

# Uptime in hours
replay_process_uptime_seconds / 3600

# Service restarted recently?
replay_process_uptime_seconds < 300
```

---

## HTTP Metrics

### `replay.http.requests_total`
**Type:** Counter
**Labels:** `method`, `endpoint`, `status_code`
**Description:** Total number of HTTP requests
**Use Cases:**
- Monitor API usage
- Track endpoint popularity
- Identify errors

**Query Examples:**
```promql
# Requests per second
rate(replay_http_requests_total[1m])

# Requests by endpoint
sum by (endpoint) (replay_http_requests_total)

# Error rate (5xx responses)
rate(replay_http_requests_total{status_code=~"5.."}[5m])

# Success rate
rate(replay_http_requests_total{status_code=~"2.."}[5m]) /
rate(replay_http_requests_total[5m])
```

---

### `replay.http.request_duration_seconds`
**Type:** Histogram
**Labels:** `method`, `endpoint`
**Description:** Duration of HTTP requests
**Use Cases:**
- Monitor API latency
- Identify slow endpoints
- SLA monitoring

**Query Examples:**
```promql
# Average request duration
avg(replay_http_request_duration_seconds)

# P95 latency by endpoint
histogram_quantile(0.95,
  sum by (endpoint, le) (
    rate(replay_http_request_duration_seconds_bucket[5m])
  )
)

# Slowest endpoints
topk(3,
  histogram_quantile(0.95,
    rate(replay_http_request_duration_seconds_bucket[5m])
  )
)
```

---

## Probe Metrics (Continuous Sync)

### `replay.probe.checks_total`
**Type:** Counter
**Labels:** `result` (new_blocks, no_change, error)
**Description:** Number of probe checks for new blocks
**Use Cases:**
- Monitor continuous sync health
- Track probe frequency
- Identify probe failures

**Query Examples:**
```promql
# Probe checks per minute
rate(replay_probe_checks_total[1m]) * 60

# Successful probes (found new blocks)
replay_probe_checks_total{result="new_blocks"}

# Probe error rate
rate(replay_probe_checks_total{result="error"}[5m])
```

---

### `replay.probe.new_blocks_detected_total`
**Type:** Counter
**Description:** Number of new blocks detected by probe
**Use Cases:**
- Monitor chain growth rate
- Track continuous sync efficiency
- Predict future blocks

**Query Examples:**
```promql
# New blocks detected per minute
rate(replay_probe_new_blocks_detected_total[1m]) * 60

# Total new blocks detected today
increase(replay_probe_new_blocks_detected_total[24h])
```

---

## Grafana Dashboard Examples

### Dashboard 1: Overview

```json
{
  "dashboard": {
    "title": "Transaction Replay Service - Overview",
    "panels": [
      {
        "title": "Blocks Processed",
        "targets": [
          {
            "expr": "rate(replay_blocks_processed_total[1m]) * 60"
          }
        ]
      },
      {
        "title": "Current Block",
        "targets": [
          {
            "expr": "replay_blocks_current_processing"
          }
        ]
      },
      {
        "title": "Sync Backlog",
        "targets": [
          {
            "expr": "replay_original_node_current_block_number - replay_syncing_node_current_block_number"
          }
        ]
      },
      {
        "title": "Throughput",
        "targets": [
          {
            "expr": "replay_throughput_blocks_per_second",
            "legendFormat": "Blocks/s"
          },
          {
            "expr": "replay_throughput_transactions_per_second",
            "legendFormat": "Transactions/s"
          }
        ]
      }
    ]
  }
}
```

### Dashboard 2: Transaction Analysis

**Panels:**
1. **Transaction Types Distribution** - Pie chart
   ```promql
   sum by (tx_type) (replay_transactions_processed_total)
   ```

2. **Transaction Versions** - Bar chart
   ```promql
   sum by (tx_version) (replay_transactions_processed_total)
   ```

3. **Transaction Latency P95** - Time series
   ```promql
   histogram_quantile(0.95, rate(replay_transactions_processing_duration_seconds_bucket[5m]))
   ```

4. **Transaction Success Rate** - Gauge
   ```promql
   rate(replay_transactions_status_total{status="success"}[5m]) / rate(replay_transactions_status_total[5m]) * 100
   ```

### Dashboard 3: Health & Errors

**Panels:**
1. **Madara Health Status** - Stat panel
   ```promql
   replay_madara_health_status
   ```

2. **Redis Connection Status** - Stat panel
   ```promql
   replay_redis_connection_status
   ```

3. **Error Rate** - Time series
   ```promql
   rate(replay_errors_total[5m]) * 60
   ```

4. **Errors by Type** - Table
   ```promql
   sum by (error_type, operation) (replay_errors_total)
   ```

---

## Alerting Examples

### Critical Alerts

```yaml
groups:
  - name: transaction_replay_critical
    rules:
      - alert: MadaraDown
        expr: replay_madara_health_status == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Madara node is down"
          description: "Madara node has been unhealthy for 1 minute"

      - alert: HighErrorRate
        expr: rate(replay_errors_total[5m]) > 10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value }} errors/second"

      - alert: BlockHashMismatch
        expr: increase(replay_blocks_status_total{status="hash_mismatch"}[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Block hash mismatch detected"
          description: "Block hash verification failed"
```

### Warning Alerts

```yaml
  - name: transaction_replay_warning
    rules:
      - alert: HighBacklog
        expr: replay_sync_backlog_blocks > 1000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High sync backlog"
          description: "Backlog is {{ $value }} blocks behind"

      - alert: SlowThroughput
        expr: replay_throughput_blocks_per_second < 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Low processing throughput"
          description: "Processing rate is {{ $value }} blocks/second"

      - alert: RedisDisconnected
        expr: replay_redis_connection_status == 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Redis connection lost"
          description: "Service lost connection to Redis"
```

---

## Best Practices

1. **Set up dashboards first** - Create Grafana dashboards before production use
2. **Configure alerts** - Set up critical alerts for Madara downtime and errors
3. **Monitor backlog** - Track `replay.sync.backlog_blocks` to ensure sync keeps up
4. **Watch throughput** - Monitor blocks/txs per second for performance issues
5. **Track errors** - Set up alerts for unusual error patterns
6. **Use histograms** - Leverage p95/p99 latency metrics for SLA monitoring
7. **Export interval** - Tune `OTEL_EXPORT_INTERVAL_MS` based on your needs (default: 30s)

---

## Troubleshooting

### No metrics appearing in Grafana

1. Check OTLP endpoint is reachable:
   ```bash
   curl -v http://localhost:4318/v1/metrics
   ```

2. Verify environment variables:
   ```bash
   echo $OTEL_ENABLED
   echo $OTEL_EXPORTER_OTLP_ENDPOINT
   ```

3. Check service logs for OpenTelemetry initialization:
   ```
   OpenTelemetry initialized successfully
   ```

### High metric cardinality

- Avoid using `process_id` label in queries unless necessary
- Use recording rules for frequently queried metrics
- Set appropriate retention policies in Prometheus/Grafana

### Performance impact

- Default export interval is 30 seconds (configurable)
- Metrics have minimal CPU/memory overhead
- Histograms use default buckets (can be tuned if needed)

---

## Support

For issues or questions:
- Check service logs for OpenTelemetry errors
- Verify OTLP collector is running and accessible
- Review Grafana data source configuration
- Check Prometheus scrape targets
