# OpenTelemetry Quick Setup Guide

This guide will help you quickly set up OpenTelemetry metrics for the Transaction Replay Service.

## Quick Start

### 1. Configure Environment Variables

Add to your `.env` file:

```bash
# OpenTelemetry Configuration
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORT_INTERVAL_MS=30000
DEPLOYMENT_ENVIRONMENT=development
```

### 2. Start OpenTelemetry Collector

Using Docker:

```bash
docker run -d \
  --name otel-collector \
  -p 4317:4317 \
  -p 4318:4318 \
  -p 8888:8888 \
  -p 8889:8889 \
  -v $(pwd)/otel-collector-config.yaml:/etc/otel-collector-config.yaml \
  otel/opentelemetry-collector:latest \
  --config=/etc/otel-collector-config.yaml
```

### 3. Create Collector Config

Save as `otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  batch:
    timeout: 10s
    send_batch_size: 1024

exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: "transaction_replay"

  logging:
    loglevel: info

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus, logging]
```

### 4. Configure Prometheus

Add to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'transaction-replay-service'
    scrape_interval: 30s
    static_configs:
      - targets: ['otel-collector:8889']
```

### 5. Configure Grafana

1. Add Prometheus data source:
   - URL: `http://prometheus:9090`
   - Save & Test

2. Import dashboard (see [METRICS.md](./METRICS.md))

### 6. Verify Setup

Check metrics are flowing:

```bash
# Check OTLP endpoint
curl http://localhost:4318/v1/metrics

# Check Prometheus endpoint
curl http://localhost:8889/metrics | grep replay
```

## Docker Compose Setup

Complete setup with Grafana:

```yaml
version: '3.8'

services:
  # Your transaction replay service
  replay-service:
    build: .
    environment:
      - OTEL_ENABLED=true
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
      - DEPLOYMENT_ENVIRONMENT=production
    depends_on:
      - otel-collector
      - redis

  # OpenTelemetry Collector
  otel-collector:
    image: otel/opentelemetry-collector:latest
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./otel-collector-config.yaml:/etc/otel-collector-config.yaml
    ports:
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
      - "8889:8889"   # Prometheus exporter

  # Prometheus
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    ports:
      - "9090:9090"
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'

  # Grafana
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on:
      - prometheus

  redis:
    image: redis:alpine
    ports:
      - "6379:6379"

volumes:
  prometheus-data:
  grafana-data:
```

Start everything:

```bash
docker-compose up -d
```

Access:
- Grafana: http://localhost:3001 (admin/admin)
- Prometheus: http://localhost:9090
- Service: http://localhost:3000

## Key Metrics to Monitor

### Essential Metrics

1. **Current Block Numbers**
   - `replay.original_node.current_block_number` - Source chain latest block
   - `replay.syncing_node.current_block_number` - Destination chain latest block

2. **Blocks Replayed Per Minute**
   ```promql
   rate(replay_blocks_processed_total[1m]) * 60
   ```

3. **Transaction Counts by Type**
   ```promql
   sum by (tx_type, tx_version) (replay_transactions_processed_total)
   ```

4. **Processing Throughput**
   - `replay.throughput.blocks_per_second`
   - `replay.throughput.transactions_per_second`

### Quick Grafana Queries

**Blocks Behind:**
```promql
replay_original_node_current_block_number - replay_syncing_node_current_block_number
```

**Transaction Type Breakdown:**
```promql
sum by (tx_type) (rate(replay_transactions_processed_total[5m]))
```

**Success Rate:**
```promql
rate(replay_blocks_status_total{status="success"}[5m]) / rate(replay_blocks_status_total[5m]) * 100
```

## Grafana Cloud Setup

If using Grafana Cloud:

1. Get your OTLP endpoint from Grafana Cloud:
   - Navigate to: Connections → Add new connection → OpenTelemetry
   - Copy the OTLP endpoint URL

2. Update `.env`:
   ```bash
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-east-0.grafana.net/otlp
   ```

3. Configure authentication in `otel-collector-config.yaml`:
   ```yaml
   exporters:
     otlp:
       endpoint: "otlp-gateway-prod-us-east-0.grafana.net:443"
       headers:
         authorization: "Basic <base64-encoded-token>"
   ```

## Troubleshooting

### Metrics not appearing

1. **Check service logs:**
   ```bash
   docker logs replay-service | grep -i "opentelemetry\|otel"
   ```

   Should see:
   ```
   OpenTelemetry initialized successfully
   ```

2. **Verify OTLP collector is receiving data:**
   ```bash
   docker logs otel-collector
   ```

3. **Check Prometheus scrape targets:**
   - Visit: http://localhost:9090/targets
   - Ensure `transaction-replay-service` is UP

4. **Test OTLP endpoint:**
   ```bash
   curl -v http://localhost:4318/v1/metrics -d '{}'
   ```

### High cardinality warnings

If you see warnings about high cardinality:

1. Remove `process_id` from queries where possible
2. Use recording rules for common queries
3. Reduce retention period in Prometheus

### Performance issues

If metrics cause performance problems:

1. Increase export interval:
   ```bash
   OTEL_EXPORT_INTERVAL_MS=60000  # 1 minute
   ```

2. Disable metrics temporarily:
   ```bash
   OTEL_ENABLED=false
   ```

3. Use sampling for high-volume metrics (future enhancement)

## Next Steps

1. Review [METRICS.md](./METRICS.md) for complete metric documentation
2. Import example Grafana dashboards
3. Set up alerting rules
4. Configure retention policies
5. Create custom dashboards for your use case

## Support

For detailed metric descriptions and Grafana dashboard examples, see [METRICS.md](./METRICS.md).
