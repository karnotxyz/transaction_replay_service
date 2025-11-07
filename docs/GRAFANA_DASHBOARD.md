# Complete Grafana Dashboard Configuration

This document provides all the Grafana queries and panel configurations you need to create a comprehensive monitoring dashboard for the Transaction Replay Service.

---

## Dashboard Layout Recommendation

```
Row 1: Overview (Stats)
Row 2: Block Processing (Time Series)
Row 3: Transaction Analysis (Mixed)
Row 4: Throughput & Performance (Time Series)
Row 5: Health & Status (Stats + Time Series)
Row 6: Errors & Issues (Table + Time Series)
```

---

## Row 1: Overview Stats (Single Stat Panels)

### Panel 1.1: Current Original Block Number
**Type:** Stat
**Query:**
```promql
replay_original_node_current_block_number
```
**Display:**
- Value: Last (not null)
- Title: "Original Node Block"
- Color: Blue
- Unit: None
- Decimals: 0

---

### Panel 1.2: Current Syncing Block Number
**Type:** Stat
**Query:**
```promql
replay_syncing_node_current_block_number
```
**Display:**
- Value: Last (not null)
- Title: "Syncing Node Block"
- Color: Green
- Unit: None
- Decimals: 0

---

### Panel 1.3: Blocks Behind (Backlog)
**Type:** Stat
**Query:**
```promql
replay_original_node_current_block_number - replay_syncing_node_current_block_number
```
**Display:**
- Value: Last (not null)
- Title: "Blocks Behind"
- Color:
  - Green: < 100
  - Yellow: 100-1000
  - Red: > 1000
- Unit: None
- Decimals: 0

---

### Panel 1.4: Total Blocks Processed
**Type:** Stat
**Query:**
```promql
replay_blocks_processed_total
```
**Display:**
- Value: Last (not null)
- Title: "Total Blocks Processed"
- Color: Purple
- Unit: None
- Decimals: 0

---

### Panel 1.5: Total Transactions Processed
**Type:** Stat
**Query:**
```promql
sum(replay_transactions_processed_total)
```
**Display:**
- Value: Last (not null)
- Title: "Total Transactions"
- Color: Orange
- Unit: short
- Decimals: 0

---

### Panel 1.6: Current Processing Rate
**Type:** Stat
**Query:**
```promql
replay_throughput_blocks_per_second
```
**Display:**
- Value: Last (not null)
- Title: "Blocks per Second"
- Color: Cyan
- Unit: ops/sec (ops)
- Decimals: 2

---

## Row 2: Block Processing (Time Series)

### Panel 2.1: Blocks Replayed Per Minute
**Type:** Time series
**Query:**
```promql
rate(replay_blocks_processed_total[1m]) * 60
```
**Display:**
- Title: "Blocks Replayed Per Minute"
- Legend: "Blocks/min"
- Y-axis: Blocks per minute
- Unit: None
- Fill opacity: 20%
- Line width: 2

---

### Panel 2.2: Block Processing Status
**Type:** Time series
**Queries:**

Query A (Success):
```promql
rate(replay_blocks_status_total{status="success"}[5m]) * 60
```

Query B (Failed):
```promql
rate(replay_blocks_status_total{status="failed"}[5m]) * 60
```

Query C (Hash Mismatch):
```promql
rate(replay_blocks_status_total{status="hash_mismatch"}[5m]) * 60
```

**Display:**
- Title: "Block Processing Status (per minute)"
- Legend: "{{status}}"
- Y-axis: Blocks per minute
- Colors:
  - Success: Green
  - Failed: Red
  - Hash Mismatch: Orange
- Fill opacity: 10%
- Stack: None

---

### Panel 2.3: Current Block Progress
**Type:** Time series
**Query:**
```promql
replay_blocks_current_processing
```
**Display:**
- Title: "Current Block Being Processed"
- Legend: "Block Number"
- Y-axis: Block number
- Unit: None
- Line interpolation: Step after
- Line width: 2

---

### Panel 2.4: Block Processing Duration (P95)
**Type:** Time series
**Queries:**

Query A (Validate):
```promql
histogram_quantile(0.95, rate(replay_block_processing_duration_seconds_bucket{operation="validate"}[5m]))
```

Query B (Set Header):
```promql
histogram_quantile(0.95, rate(replay_block_processing_duration_seconds_bucket{operation="set_header"}[5m]))
```

Query C (Process Txs):
```promql
histogram_quantile(0.95, rate(replay_block_processing_duration_seconds_bucket{operation="process_txs"}[5m]))
```

Query D (Close Block):
```promql
histogram_quantile(0.95, rate(replay_block_processing_duration_seconds_bucket{operation="close_block"}[5m]))
```

Query E (Verify Hash):
```promql
histogram_quantile(0.95, rate(replay_block_processing_duration_seconds_bucket{operation="verify_hash"}[5m]))
```

**Display:**
- Title: "Block Processing Duration (P95)"
- Legend: "{{operation}}"
- Y-axis: Duration (seconds)
- Unit: seconds (s)
- Fill opacity: 0%
- Line width: 2

---

## Row 3: Transaction Analysis

### Panel 3.1: Transactions by Type (Pie Chart)
**Type:** Pie chart
**Query:**
```promql
sum by (tx_type) (replay_transactions_processed_total)
```
**Display:**
- Title: "Transaction Distribution by Type"
- Legend: "{{tx_type}}"
- Value: Total
- Unit: short
- Display labels: Name and percent

---

### Panel 3.2: Transactions by Version (Bar Gauge)
**Type:** Bar gauge
**Query:**
```promql
sum by (tx_version) (replay_transactions_processed_total)
```
**Display:**
- Title: "Transactions by Version"
- Legend: "{{tx_version}}"
- Orientation: Horizontal
- Display mode: Gradient
- Unit: short
- Show values: Always

---

### Panel 3.3: Transaction Processing Rate
**Type:** Time series
**Queries:**

Query A (INVOKE):
```promql
sum(rate(replay_transactions_processed_total{tx_type="INVOKE"}[5m])) * 60
```

Query B (DECLARE):
```promql
sum(rate(replay_transactions_processed_total{tx_type="DECLARE"}[5m])) * 60
```

Query C (DEPLOY_ACCOUNT):
```promql
sum(rate(replay_transactions_processed_total{tx_type="DEPLOY_ACCOUNT"}[5m])) * 60
```

Query D (L1_HANDLER):
```promql
sum(rate(replay_transactions_processed_total{tx_type="L1_HANDLER"}[5m])) * 60
```

**Display:**
- Title: "Transaction Processing Rate (per minute)"
- Legend: "{{tx_type}}"
- Y-axis: Transactions per minute
- Unit: None
- Fill opacity: 10%
- Stack: Normal (stacked)

---

### Panel 3.4: Transaction Processing Duration (P95)
**Type:** Time series
**Query:**
```promql
histogram_quantile(0.95, sum by (tx_type, le) (rate(replay_transactions_processing_duration_seconds_bucket[5m])))
```
**Display:**
- Title: "Transaction Processing Duration P95 by Type"
- Legend: "{{tx_type}}"
- Y-axis: Duration (seconds)
- Unit: seconds (s)
- Fill opacity: 0%
- Line width: 2

---

### Panel 3.5: Transaction Success Rate
**Type:** Stat
**Query:**
```promql
(sum(rate(replay_transactions_status_total{status="success"}[5m])) / sum(rate(replay_transactions_status_total[5m]))) * 100
```
**Display:**
- Title: "Transaction Success Rate"
- Value: Last (not null)
- Unit: percent (0-100)
- Color:
  - Green: > 99
  - Yellow: 95-99
  - Red: < 95
- Decimals: 2

---

### Panel 3.6: Detailed Transaction Breakdown (Table)
**Type:** Table
**Query:**
```promql
sum by (tx_type, tx_version) (replay_transactions_processed_total)
```
**Display:**
- Title: "Transaction Type & Version Breakdown"
- Columns: tx_type, tx_version, Value
- Sort by: Value (descending)
- Unit: short

---

## Row 4: Throughput & Performance

### Panel 4.1: Blocks Per Second
**Type:** Time series
**Query:**
```promql
replay_throughput_blocks_per_second
```
**Display:**
- Title: "Blocks Processing Rate"
- Legend: "Blocks/sec"
- Y-axis: Rate
- Unit: ops/sec (ops)
- Fill opacity: 20%
- Line width: 2
- Color: Blue

---

### Panel 4.2: Transactions Per Second
**Type:** Time series
**Query:**
```promql
replay_throughput_transactions_per_second
```
**Display:**
- Title: "Transaction Processing Rate"
- Legend: "Txs/sec"
- Y-axis: Rate
- Unit: ops/sec (ops)
- Fill opacity: 20%
- Line width: 2
- Color: Green

---

### Panel 4.3: Sync Progress Percentage
**Type:** Gauge
**Query:**
```promql
replay_sync_progress_percent
```
**Display:**
- Title: "Sync Progress"
- Min: 0
- Max: 100
- Unit: percent (0-100)
- Thresholds:
  - 0-50: Red
  - 50-90: Yellow
  - 90-100: Green
- Show threshold markers: Yes

---

### Panel 4.4: Sync Backlog Over Time
**Type:** Time series
**Query:**
```promql
replay_sync_backlog_blocks
```
**Display:**
- Title: "Sync Backlog (Blocks Behind)"
- Legend: "Blocks behind"
- Y-axis: Blocks
- Unit: None
- Fill opacity: 30%
- Line width: 2
- Color: Orange

---

### Panel 4.5: Active Sync Processes
**Type:** Stat
**Queries:**

Query A (Sequential):
```promql
replay_sync_active_processes{sync_mode="sequential"}
```

Query B (Snap Sync):
```promql
replay_sync_active_processes{sync_mode="snap_sync"}
```

**Display:**
- Title: "Active Sync Processes"
- Layout: Auto
- Value: Last (not null)
- Unit: None
- Color: Blue

---

### Panel 4.6: Receipt Validation Retries
**Type:** Time series
**Query:**
```promql
sum(rate(replay_transactions_receipt_retries_total[5m])) * 60
```
**Display:**
- Title: "Receipt Validation Retries (per minute)"
- Legend: "Retries/min"
- Y-axis: Retries per minute
- Unit: None
- Fill opacity: 20%
- Line width: 2
- Color: Yellow

---

## Row 5: Health & Status

### Panel 5.1: Madara Health Status
**Type:** Stat
**Query:**
```promql
replay_madara_health_status
```
**Display:**
- Title: "Madara Health"
- Value: Last (not null)
- Unit: None
- Value mappings:
  - 0: "DOWN" (Red)
  - 1: "HEALTHY" (Green)
- Color:
  - Red: = 0
  - Green: = 1

---

### Panel 5.2: Redis Connection Status
**Type:** Stat
**Query:**
```promql
replay_redis_connection_status
```
**Display:**
- Title: "Redis Connection"
- Value: Last (not null)
- Unit: None
- Value mappings:
  - 0: "DISCONNECTED" (Red)
  - 1: "CONNECTED" (Green)
- Color:
  - Red: = 0
  - Green: = 1

---

### Panel 5.3: Madara Uptime Percentage (24h)
**Type:** Stat
**Query:**
```promql
avg_over_time(replay_madara_health_status[24h]) * 100
```
**Display:**
- Title: "Madara Uptime (24h)"
- Value: Last (not null)
- Unit: percent (0-100)
- Decimals: 2
- Color:
  - Green: > 99
  - Yellow: 95-99
  - Red: < 95

---

### Panel 5.4: Madara Recovery Events
**Type:** Time series
**Query:**
```promql
increase(replay_madara_recovery_events_total[1h])
```
**Display:**
- Title: "Madara Recovery Events (per hour)"
- Legend: "Recovery events"
- Y-axis: Count
- Unit: short
- Fill opacity: 0%
- Line width: 2
- Draw style: Bars
- Color: Orange

---

### Panel 5.5: Madara Downtime Duration
**Type:** Time series
**Query:**
```promql
histogram_quantile(0.95, rate(replay_madara_downtime_duration_seconds_bucket[1h]))
```
**Display:**
- Title: "Madara Downtime Duration (P95)"
- Legend: "Downtime (seconds)"
- Y-axis: Duration
- Unit: seconds (s)
- Fill opacity: 20%
- Line width: 2
- Color: Red

---

### Panel 5.6: Service Uptime
**Type:** Stat
**Query:**
```promql
replay_process_uptime_seconds / 3600
```
**Display:**
- Title: "Service Uptime"
- Value: Last (not null)
- Unit: hours (h)
- Decimals: 1
- Color: Blue

---

## Row 6: Errors & Issues

### Panel 6.1: Error Rate
**Type:** Time series
**Query:**
```promql
sum(rate(replay_errors_total[5m])) * 60
```
**Display:**
- Title: "Error Rate (per minute)"
- Legend: "Errors/min"
- Y-axis: Errors per minute
- Unit: None
- Fill opacity: 30%
- Line width: 2
- Color: Red

---

### Panel 6.2: Errors by Type (Table)
**Type:** Table
**Query:**
```promql
sum by (error_type, operation) (increase(replay_errors_total[1h]))
```
**Display:**
- Title: "Errors by Type (Last Hour)"
- Columns: error_type, operation, Value
- Sort by: Value (descending)
- Unit: short
- Filter: Value > 0

---

### Panel 6.3: Top Error Types (Bar Chart)
**Type:** Bar chart
**Query:**
```promql
topk(10, sum by (error_type) (increase(replay_errors_total[1h])))
```
**Display:**
- Title: "Top 10 Error Types (Last Hour)"
- Legend: "{{error_type}}"
- Orientation: Horizontal
- Unit: short
- Show values: Always

---

### Panel 6.4: Block Hash Mismatches
**Type:** Stat
**Query:**
```promql
increase(replay_blocks_status_total{status="hash_mismatch"}[1h])
```
**Display:**
- Title: "Block Hash Mismatches (Last Hour)"
- Value: Last (not null)
- Unit: short
- Color:
  - Green: = 0
  - Red: > 0
- Decimals: 0

---

### Panel 6.5: HTTP Error Rate (5xx)
**Type:** Time series
**Query:**
```promql
sum(rate(replay_http_requests_total{status_code=~"5.."}[5m])) * 60
```
**Display:**
- Title: "HTTP 5xx Error Rate (per minute)"
- Legend: "5xx errors/min"
- Y-axis: Errors per minute
- Unit: None
- Fill opacity: 20%
- Line width: 2
- Color: Red

---

### Panel 6.6: HTTP Request Duration (P95)
**Type:** Time series
**Query:**
```promql
histogram_quantile(0.95, sum by (endpoint, le) (rate(replay_http_request_duration_seconds_bucket[5m])))
```
**Display:**
- Title: "HTTP Request Duration P95 by Endpoint"
- Legend: "{{endpoint}}"
- Y-axis: Duration (seconds)
- Unit: seconds (s)
- Fill opacity: 0%
- Line width: 2

---

## Row 7: Continuous Sync (Probe Metrics)

### Panel 7.1: Probe Check Results
**Type:** Time series
**Queries:**

Query A (New Blocks):
```promql
rate(replay_probe_checks_total{result="new_blocks"}[5m]) * 60
```

Query B (No Change):
```promql
rate(replay_probe_checks_total{result="no_change"}[5m]) * 60
```

Query C (Error):
```promql
rate(replay_probe_checks_total{result="error"}[5m]) * 60
```

**Display:**
- Title: "Probe Check Results (per minute)"
- Legend: "{{result}}"
- Y-axis: Checks per minute
- Colors:
  - new_blocks: Green
  - no_change: Blue
  - error: Red
- Fill opacity: 10%
- Stack: Normal

---

### Panel 7.2: New Blocks Detected by Probe
**Type:** Time series
**Query:**
```promql
rate(replay_probe_new_blocks_detected_total[5m]) * 60
```
**Display:**
- Title: "New Blocks Detected (per minute)"
- Legend: "Blocks/min"
- Y-axis: Blocks per minute
- Unit: None
- Fill opacity: 20%
- Line width: 2
- Color: Green

---

## Additional Useful Queries

### Combined Sync Health Score
**Type:** Stat
**Query:**
```promql
(
  (replay_madara_health_status * 0.4) +
  (replay_redis_connection_status * 0.2) +
  (clamp_max(1 - (replay_sync_backlog_blocks / 10000), 1) * 0.4)
) * 100
```
**Display:**
- Title: "Sync Health Score"
- Unit: percent (0-100)
- Color:
  - Green: > 80
  - Yellow: 50-80
  - Red: < 50

---

### Estimated Time to Catch Up
**Type:** Stat
**Query:**
```promql
(replay_original_node_current_block_number - replay_syncing_node_current_block_number) /
(rate(replay_blocks_processed_total[5m]) * 60)
```
**Display:**
- Title: "Est. Time to Catch Up"
- Unit: minutes (m)
- Decimals: 0
- Note: Shows minutes at current processing rate

---

### Average Transactions Per Block
**Type:** Stat
**Query:**
```promql
sum(rate(replay_transactions_processed_total[5m])) / rate(replay_blocks_processed_total[5m])
```
**Display:**
- Title: "Avg Transactions per Block"
- Unit: None
- Decimals: 1

---

## Complete Dashboard JSON Template

Save this as a starting point and customize:

```json
{
  "dashboard": {
    "title": "Transaction Replay Service",
    "tags": ["starknet", "replay", "blockchain"],
    "timezone": "browser",
    "refresh": "30s",
    "time": {
      "from": "now-6h",
      "to": "now"
    },
    "panels": [
      {
        "title": "Current Original Block",
        "type": "stat",
        "gridPos": {"h": 4, "w": 4, "x": 0, "y": 0},
        "targets": [
          {
            "expr": "replay_original_node_current_block_number",
            "refId": "A"
          }
        ]
      },
      {
        "title": "Current Syncing Block",
        "type": "stat",
        "gridPos": {"h": 4, "w": 4, "x": 4, "y": 0},
        "targets": [
          {
            "expr": "replay_syncing_node_current_block_number",
            "refId": "A"
          }
        ]
      },
      {
        "title": "Blocks Behind",
        "type": "stat",
        "gridPos": {"h": 4, "w": 4, "x": 8, "y": 0},
        "targets": [
          {
            "expr": "replay_original_node_current_block_number - replay_syncing_node_current_block_number",
            "refId": "A"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "thresholds": {
              "steps": [
                {"value": 0, "color": "green"},
                {"value": 100, "color": "yellow"},
                {"value": 1000, "color": "red"}
              ]
            }
          }
        }
      }
    ]
  }
}
```

---

## Alert Rules

### Critical Alerts

**Madara Down:**
```promql
replay_madara_health_status == 0
```
Fire when: For 1 minute

**High Error Rate:**
```promql
sum(rate(replay_errors_total[5m])) * 60 > 10
```
Fire when: For 2 minutes

**Block Hash Mismatch:**
```promql
increase(replay_blocks_status_total{status="hash_mismatch"}[5m]) > 0
```
Fire when: Immediately

### Warning Alerts

**High Backlog:**
```promql
replay_sync_backlog_blocks > 1000
```
Fire when: For 10 minutes

**Low Throughput:**
```promql
replay_throughput_blocks_per_second < 0.1
```
Fire when: For 5 minutes

**Redis Disconnected:**
```promql
replay_redis_connection_status == 0
```
Fire when: For 1 minute

---

## Dashboard Variables

Add these template variables for flexibility:

**Environment:**
```promql
label_values(replay_blocks_processed_total, deployment_environment)
```

**Time Range (auto-refresh):**
- Options: 5m, 15m, 30m, 1h, 6h, 12h, 24h, 7d

---

## Import Instructions

1. **In Grafana:**
   - Go to Dashboards → New → Import
   - Create panels using queries above
   - Save dashboard

2. **Or use Provisioning:**
   - Save dashboard JSON to `/etc/grafana/provisioning/dashboards/`
   - Restart Grafana

3. **Set Data Source:**
   - All queries use Prometheus data source
   - Set default data source or select per panel

---

This complete set of queries covers all aspects of your Transaction Replay Service monitoring needs!
