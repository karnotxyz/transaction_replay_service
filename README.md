# Transaction Replay Service Documentation

## Overview

The Transaction Replay Service picks up transactions from one node (original node) and replays them to another node (syncing node). It now includes **Redis-based persistence** for automatic recovery from pod evictions and restarts.

### Key Features

- ✅ **Block Range Sync**: Sync specific block ranges
- ✅ **Continuous Sync**: Sync to latest and keep going ("LATEST" mode)
- ✅ **Auto-Resume**: Automatically resumes interrupted syncs after pod restart
- ✅ **Redis Persistence**: Progress saved to Redis every block
- ✅ **Graceful Cancellation**: Stop syncs cleanly or complete current block
- ✅ **Periodic Recovery**: Checks for incomplete syncs every 3 minutes
- ✅ **Redis Reconnection**: Auto-resumes when Redis reconnects after eviction

---

## 🚀 Quick Start with Helm

### Prerequisites

- Kubernetes cluster
- Helm 3.x
- kubectl configured

### Deploy with Helm (Recommended)

```bash
# 1. Clone or download the helm chart
cd transaction-syncing-service-chart

# 2. Update values.yaml
vim values.yaml

# Update these values:
# - transaction_syncing_service.image.tag: <your-image-tag>
# - redis.persistence.storageClass: <your-storage-class>
# - transaction_syncing_service.environment.RPC_URL_ORIGINAL_NODE
# - transaction_syncing_service.environment.RPC_URL_SYNCING_NODE
# - transaction_syncing_service.environment.ADMIN_RPC_URL_SYNCING_NODE

# 3. Deploy
helm install transaction-syncing-service . \
  --namespace madara-system \
  --create-namespace

# 4. Verify deployment
kubectl get pods -n madara-system
```

### Deployed Components

The Helm chart deploys:
- **Transaction Syncing Service** (Deployment)
- **Redis** (StatefulSet with persistent storage)
- **Services** for both components
- **ConfigMaps** for configuration
- **PVC** for Redis data persistence

---

## 📋 Pre-requisites

### Images

#### Transaction Replay Service
- **Image**: `heemank/txn_replay_service:persistence_d9a23cf915f34cc4f03d6b2ed7f3754402df22ca`
- **Available Tags**:
  - `redis-reconnect-fix` - Latest with Redis reconnection handling
  - `fix-continuous-resume` - Includes continuous sync auto-resume fix
  - `persistence_56809cc5` - Basic persistence support

#### Redis
- **Image**: `redis:7-alpine`
- **Purpose**: Persistence layer for sync state
- **Storage**: Requires persistent volume (5Gi minimum, 20Gi recommended)

---

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `RPC_URL_ORIGINAL_NODE` | Paradex network node RPC URL | Yes | `https://pathfinder.api.nightly.paradex.trade` |
| `RPC_URL_SYNCING_NODE` | Madara node RPC URL | Yes | `http://madara-service:9944` |
| `ADMIN_RPC_URL_SYNCING_NODE` | Madara admin RPC URL | Yes | `http://madara-service:9943` |
| `REDIS_URL` | Redis connection URL | Yes | `redis://redis-instance:6379` |
| `PORT` | Service port (optional) | No | `3000` (default) |

### Helm Values Configuration

```yaml
# values.yaml

transaction_syncing_service:
  image:
    repository: "heemank/txn_replay_service"
    tag: "redis-reconnect-fix"  # Update to your version
  
  replicas: 1  # Single instance recommended
  
  resources:
    limits:
      cpu: 500m
      memory: 1Gi
    requests:
      cpu: 250m
      memory: 512Mi
  
  environment:
    RPC_URL_ORIGINAL_NODE: "https://pathfinder.api.nightly.paradex.trade"
    RPC_URL_SYNCING_NODE: "http://madara-service:9944"
    ADMIN_RPC_URL_SYNCING_NODE: "http://madara-service:9943"
    REDIS_URL: "redis://redis-instance:6379"

redis:
  enabled: true
  replicas: 1
  
  persistence:
    enabled: true
    storageClass: "standard"  # Update to your storage class!
    size: 5Gi  # Minimum; 20Gi recommended for production
  
  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 256Mi
```

---

## 🐳 Docker Deployment (Manual)

### Transaction Syncing Service

```bash
docker run -d \
  --name transaction_syncing_service \
  -p 3000:3000 \
  -e RPC_URL_ORIGINAL_NODE=https://pathfinder.api.nightly.paradex.trade \
  -e RPC_URL_SYNCING_NODE=http://madara:9944 \
  -e ADMIN_RPC_URL_SYNCING_NODE=http://madara:9943 \
  -e REDIS_URL=redis://redis:6379 \
  heemank/txn_replay_service:redis-reconnect-fix
```

### Redis (Required)

```bash
docker run -d \
  --name redis \
  -p 6379:6379 \
  -v redis-data:/data \
  redis:7-alpine \
  redis-server --appendonly yes
```

---

## 📡 API Documentation

### Base Configuration

- **Base URL**: `http://localhost:3000` (or your service URL)
- **Content-Type**: `application/json`
- **Port**: `3000` (default)

---

## 🔗 API Endpoints

### 1. Start Sync Process

Initiates a new blockchain synchronization process.

**Endpoint**: `POST /sync`

#### Sync Modes

##### Fixed Range Sync
Sync from block A to block B and stop.

```bash
curl -X POST http://localhost:3000/sync \
  -H 'Content-Type: application/json' \
  -d '{
    "syncFrom": 830006,
    "syncTo": 830010,
    "startTxIndex": 0
  }'
```

##### Continuous Sync (NEW!)
Sync to latest block and keep syncing new blocks as they arrive.

```bash
curl -X POST http://localhost:3000/sync \
  -H 'Content-Type: application/json' \
  -d '{
    "syncFrom": 830006,
    "syncTo": "LATEST",
    "startTxIndex": 0
  }'
```

#### Request Body

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `syncFrom` | integer | Yes | Starting block number |
| `syncTo` | integer or "LATEST" | Yes | Ending block number or "LATEST" for continuous sync |
| `startTxIndex` | integer | Yes | Transaction index to start from (usually 0) |

#### Success Response

**Status Code**: `200 OK`

```json
{
  "message": "Sync process started successfully",
  "processId": "024630a7-3b1f-4997-95dd-60048e5e6264",
  "syncMode": "continuous",
  "status": {
    "syncFrom": 830006,
    "syncTo": "LATEST",
    "startTxIndex": 0,
    "estimatedBlocks": null
  },
  "persistence": {
    "enabled": true,
    "message": "Progress will be saved to Redis - sync will auto-resume if pod restarts"
  }
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Status message |
| `processId` | string | Unique UUID for this sync process |
| `syncMode` | string | `"fixed_range"` or `"continuous"` |
| `status.syncFrom` | integer | Starting block |
| `status.syncTo` | integer or string | Ending block or "LATEST" |
| `status.startTxIndex` | integer | Starting transaction index |
| `status.estimatedBlocks` | integer or null | Total blocks (null for continuous) |
| `persistence.enabled` | boolean | Whether Redis persistence is active |

#### Error Responses

**Already Running**
```json
{
  "error": "A sync process is already running",
  "currentProcess": {
    "id": "...",
    "status": "running"
  }
}
```

**Invalid Parameters**
```json
{
  "error": "syncFrom, syncTo, and startTxIndex are required"
}
```

---

### 2. Get Sync Status

Get the status of a specific sync process or all processes.

**Endpoint**: `GET /sync/status/:processId` or `GET /sync/status`

#### Get Specific Process Status

```bash
curl http://localhost:3000/sync/status/024630a7-3b1f-4997-95dd-60048e5e6264
```

**Success Response** (Fixed Range):
```json
{
  "processId": "024630a7-3b1f-4997-95dd-60048e5e6264",
  "status": "running",
  "syncMode": "fixed_range",
  "progress": {
    "syncFrom": 830006,
    "syncTo": 830010,
    "currentBlock": 830008,
    "currentTxIndex": 5,
    "processedBlocks": 2,
    "totalBlocks": 5,
    "percentComplete": 40.0
  },
  "timing": {
    "startTime": "2025-10-22T10:30:00.000Z",
    "runningFor": "2m 30s"
  },
  "persistence": {
    "savedToRedis": true,
    "lastSaved": "2025-10-22T10:32:25.000Z",
    "autoResumeEnabled": true
  }
}
```

**Success Response** (Continuous Sync):
```json
{
  "processId": "abc-123-def-456",
  "status": "running",
  "syncMode": "continuous",
  "progress": {
    "syncFrom": 830006,
    "syncTo": "LATEST",
    "currentBlock": 831500,
    "currentTxIndex": 12,
    "processedBlocks": 1494,
    "totalBlocks": null,
    "percentComplete": null
  },
  "timing": {
    "startTime": "2025-10-22T08:00:00.000Z",
    "runningFor": "2h 35m"
  },
  "persistence": {
    "savedToRedis": true,
    "lastSaved": "2025-10-22T10:35:12.000Z",
    "autoResumeEnabled": true
  }
}
```

#### Get All Processes Status

```bash
curl http://localhost:3000/sync/status
```

**Success Response**:
```json
{
  "currentProcess": {
    "processId": "024630a7-3b1f-4997-95dd-60048e5e6264",
    "status": "running",
    "syncMode": "continuous"
  },
  "message": "Sync process is running"
}
```

**No Sync Running**:
```json
{
  "message": "No sync process running"
}
```

---

### 3. Cancel Sync Process

Gracefully stop an active synchronization process.

**Endpoint**: `POST /sync/cancel`

#### Request Body

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `complete_current_block` | boolean | No (default: false) | If true, completes current block before stopping. If false, stops after current transaction. |

#### Example Requests

**Stop After Current Transaction**:
```bash
curl -X POST http://localhost:3000/sync/cancel \
  -H 'Content-Type: application/json' \
  -d '{
    "complete_current_block": false
  }'
```

**Complete Current Block First**:
```bash
curl -X POST http://localhost:3000/sync/cancel \
  -H 'Content-Type: application/json' \
  -d '{
    "complete_current_block": true
  }'
```

#### Success Response

```json
{
  "message": "Cancellation requested - will complete current block and stop",
  "processId": "024630a7-3b1f-4997-95dd-60048e5e6264",
  "cancellationMode": "complete_current_block",
  "currentBlock": 830008,
  "currentTxIndex": 5,
  "note": "Process will complete all transactions in current block before stopping",
  "resumeInfo": {
    "message": "To resume from this point, use these parameters in your next sync request:",
    "syncFrom": 830008,
    "startTxIndex": 0
  },
  "persistence": {
    "savedState": true,
    "message": "Current progress saved to Redis. Use /sync/resume/:processId to continue."
  }
}
```

#### Response Fields

| Field | Description |
|-------|-------------|
| `cancellationMode` | `"immediate"` or `"complete_current_block"` |
| `resumeInfo` | Parameters to resume from this point |
| `persistence.savedState` | Whether state was saved to Redis |

---

### 4. Resume Sync Process (NEW!)

Manually resume a previously stopped or interrupted sync.

**Endpoint**: `POST /sync/resume/:processId`

```bash
curl -X POST http://localhost:3000/sync/resume/024630a7-3b1f-4997-95dd-60048e5e6264
```

#### Success Response

```json
{
  "message": "Sync process resumed successfully",
  "processId": "024630a7-3b1f-4997-95dd-60048e5e6264",
  "resumedFrom": {
    "block": 830008,
    "txIndex": 5
  },
  "syncMode": "continuous",
  "status": "running"
}
```

#### Error Responses

**Process Not Found**:
```json
{
  "error": "No saved state found for process 024630a7-3b1f-4997-95dd-60048e5e6264"
}
```

**Already Running**:
```json
{
  "error": "Cannot resume - another sync is already running"
}
```

**Already Completed**:
```json
{
  "error": "Cannot resume - process is already completed"
}
```

---

### 5. Process History

Get history of recent sync processes.

**Endpoint**: `GET /sync/history?limit=10`

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 10 | Maximum number of processes to return |

```bash
curl http://localhost:3000/sync/history?limit=5
```

#### Success Response

```json
{
  "processes": [
    {
      "processId": "abc-123",
      "status": "completed",
      "syncFrom": 830006,
      "syncTo": 830010,
      "currentBlock": 830010,
      "currentTxIndex": 50,
      "progress": "5/5 blocks",
      "startTime": "2025-10-22T10:00:00.000Z",
      "endTime": "2025-10-22T10:15:00.000Z",
      "duration": 900000,
      "error": null
    },
    {
      "processId": "def-456",
      "status": "running",
      "syncFrom": 830011,
      "syncTo": "LATEST",
      "currentBlock": 831500,
      "currentTxIndex": 12,
      "progress": "1489/null blocks",
      "startTime": "2025-10-22T10:20:00.000Z",
      "endTime": null,
      "duration": null,
      "error": null
    }
  ]
}
```

---

### 6. Health Check

Check service health and Redis connection status.

**Endpoint**: `GET /health`

```bash
curl http://localhost:3000/health
```

#### Success Response

```json
{
  "status": "ok",
  "timestamp": "2025-10-22T10:35:00.000Z",
  "uptime": 3600,
  "service": "transaction_replay_service",
  "redis": {
    "connected": true,
    "url": "redis://redis-instance:6379"
  },
  "features": {
    "persistence": true,
    "autoResume": true,
    "periodicChecks": true
  }
}
```

#### Degraded Response (Redis Down)

**Status Code**: `503 Service Unavailable`

```json
{
  "status": "degraded",
  "timestamp": "2025-10-22T10:35:00.000Z",
  "uptime": 3600,
  "service": "transaction_replay_service",
  "redis": {
    "connected": false,
    "url": "redis://redis-instance:6379"
  },
  "warning": "Service running but persistence unavailable - syncs may not auto-resume"
}
```

---

## 🔄 Auto-Resume Feature

### How It Works

The service automatically resumes interrupted syncs using **three safety nets**:

1. **Startup Check** (2 seconds after start)
   - Checks Redis for incomplete processes
   - Automatically resumes from last saved position

2. **Redis Reconnection Callback**
   - Triggers when Redis reconnects after disconnection
   - Immediately checks for incomplete processes
   - Critical for Redis pod evictions

3. **Periodic Checks** (every 3 minutes)
   - Background task checks for incomplete syncs
   - Catches anything the other methods missed
   - Ensures eventual consistency

### Progress Persistence

Progress is saved to Redis:
- ✅ After every block completes
- ✅ On graceful shutdown
- ✅ Before pod termination (SIGTERM)

Saved data includes:
- Current block number
- Current transaction index
- Sync range (from/to)
- Process ID
- Status

### Recovery Time

| Scenario | Recovery Method | Time |
|----------|----------------|------|
| Pod restart | Startup check | ~2 seconds |
| Redis restart | Reconnection callback | Immediate |
| Missed by both | Periodic check | ≤ 3 minutes |

### Example: Auto-Resume After Pod Eviction

```bash
# 1. Start a sync
curl -X POST http://localhost:3000/sync \
  -d '{"syncFrom": 830006, "syncTo": "LATEST", "startTxIndex": 0}'

# 2. Pod gets evicted
kubectl delete pod transaction-syncing-service-xxx

# 3. New pod starts
# Service automatically:
# - Connects to Redis
# - Finds incomplete sync
# - Resumes from last saved position

# 4. Check logs
kubectl logs -f transaction-syncing-service-yyy

# Output:
# [INFO] Redis connected successfully
# [INFO] Starting periodic auto-resume check (every 3 minutes)
# [INFO] Checking Redis for incomplete sync processes...
# [INFO] Found 1 incomplete process(es)
# [INFO] Process abc-123 is continuous sync - will resume from block 830015, tx 3
# [INFO] Auto-resuming process abc-123 from block 830015, tx 3
# [INFO] Successfully auto-resumed process abc-123
```

---

## 🔧 Operator Integration

### Changes Required

#### 1. Update Madara Docker Image

Replace Madara image in operator CRD:
```yaml
image: prkpandey942/madara:paradex_sync_d13b45c1b041bfa6b490f15ce21509d50ac15fd1
```

#### 2. Update Chain Config

Replace `madara-chain-config` ConfigMap with `configs/paradex.yaml`.

Set `latest_protocol_version` based on block range:
- `0.13.2` for blocks 95271-559325
- `0.13.5` for blocks 559326+

#### 3. Disable Bootstrapper & Orchestrator

In Madara CRD, set replicas to 0:
```yaml
spec:
  bootstrapper:
    replicas: 0
  orchestrator:
    replicas: 0
```

#### 4. Use Prepared Database

Mount existing Madara database:
```yaml
volumeMounts:
  - name: madara-db
    mountPath: /data
```

#### 5. Deploy Transaction Replay Service

Deploy using the provided Helm chart or manually with the configurations above.

---

## 📊 Monitoring & Logs

### Key Log Messages

**Startup**:
```
[INFO] Syncing service listening on port 3000
[INFO] Redis connected successfully
[INFO] Starting periodic auto-resume check (every 3 minutes)
[INFO] Checking Redis for incomplete sync processes...
```

**During Sync**:
```
[INFO] Syncing block 830015 (Process: abc-123, Mode: continuous)...
[INFO] Replayed 45 transactions for block 830015
[INFO] Progress saved to Redis
```

**Auto-Resume**:
```
[INFO] Found 1 incomplete process(es)
[INFO] Process abc-123 is continuous sync - will resume from block 830015, tx 3
[INFO] Auto-resuming process abc-123 from block 830015, tx 3
[INFO] Successfully auto-resumed process abc-123
```

**Redis Issues**:
```
[ERROR] Redis error: connect ECONNREFUSED
[INFO] Redis reconnecting...
[INFO] Redis reconnected - attempting auto-resume
```

**Periodic Checks**:
```
[INFO] Periodic auto-resume check starting...
[DEBUG] Periodic check skipped - sync already running
```

### Prometheus Metrics (Optional)

Add Prometheus endpoint for metrics:
```bash
curl http://localhost:3000/metrics
```

Recommended metrics:
- `sync_blocks_processed_total`
- `sync_transactions_processed_total`
- `redis_reconnect_total`
- `auto_resume_attempts_total`
- `auto_resume_success_total`

---

## 🐛 Troubleshooting

### Service Won't Start

**Check Redis connection**:
```bash
kubectl logs -l app=transaction-syncing-service -n madara-system | grep -i redis
```

**Verify environment variables**:
```bash
kubectl get configmap transaction-syncing-service-config -n madara-system -o yaml
```

### Sync Not Auto-Resuming

**Check Redis has data**:
```bash
REDIS_POD=$(kubectl get pod -l app=redis-instance -n madara-system -o jsonpath="{.items[0].metadata.name}")
kubectl exec -it $REDIS_POD -n madara-system -- redis-cli KEYS "sync:*"
```

**Check service logs**:
```bash
kubectl logs -l app=transaction-syncing-service -n madara-system | grep "auto-resume"
```

### Redis Connection Issues

**Check Redis pod status**:
```bash
kubectl get pod redis-instance-0 -n madara-system
kubectl describe pod redis-instance-0 -n madara-system
```

**Check PVC is bound**:
```bash
kubectl get pvc redis-instance-pvc -n madara-system
```

### Sync Process Stuck

**Check current status**:
```bash
curl http://localhost:3000/sync/status
```

**Cancel and restart**:
```bash
curl -X POST http://localhost:3000/sync/cancel \
  -d '{"complete_current_block": true}'

# Wait for cancellation
sleep 5

# Resume from saved position
curl -X POST http://localhost:3000/sync/resume/<processId>
```

---

## 📝 Best Practices

### Production Deployment

1. **Use Persistent Storage for Redis**
   - Minimum 5Gi, recommended 20Gi
   - Use SSD storage class for better performance
   - Enable backups/snapshots

2. **Resource Allocation**
   - Transaction Service: 250m-500m CPU, 512Mi-1Gi RAM
   - Redis: 100m-500m CPU, 256Mi-512Mi RAM

3. **Monitoring**
   - Set up alerts for pod restarts
   - Monitor Redis connection status
   - Track sync progress

4. **High Availability**
   - Keep single instance (multiple instances not supported)
   - Use pod disruption budgets
   - Monitor auto-resume functionality

### Development/Testing

1. **Use Smaller Storage**
   - 1Gi Redis storage sufficient for testing
   - Can disable persistence for quick tests

2. **Test Auto-Resume**
   - Regularly test pod evictions
   - Verify Redis reconnection handling
   - Check periodic recovery

---

## 📚 Additional Resources

### Helm Chart
- Complete Helm chart available in repository
- Includes Redis with persistence
- Pre-configured for auto-resume

### Support
- For database support, contact the team
- For operator integration, refer to operator documentation
- For issues, check logs and troubleshooting section

---

## 🔄 Version History

### v2.0 (Current) - Redis Persistence
- ✅ Added Redis-based persistence
- ✅ Auto-resume on pod restart
- ✅ Continuous sync mode ("LATEST")
- ✅ Periodic recovery checks (3 min)
- ✅ Redis reconnection handling
- ✅ Graceful cancellation with state saving
- ✅ Manual resume endpoint
- ✅ Process history endpoint

### v1.0 - Initial Release
- Basic block range synchronization
- Manual sync control
- No persistence (syncs lost on restart)

---

## 📞 Support

For assistance with:
- Database setup and preparation
- Operator integration
- Production deployment
- Issue resolution

Contact the support team or refer to the project repository.
