# CLAUDE.md - Transaction Replay Service

> This file provides context for Claude Code when working on this codebase. Keep this updated as features evolve.

## Project Overview

**Transaction Replay Service** - A Node.js/TypeScript service that synchronizes Starknet blocks from a source node (e.g., Pathfinder) to a destination Madara node by replaying transactions.

### Core Purpose
- Replay transactions from an original Starknet node to a syncing Madara node
- Support both fixed-block and continuous (latest-following) sync modes
- Automatic recovery from failures with chain integrity validation
- Comprehensive observability via OpenTelemetry

### Tech Stack
- **Runtime:** Node.js 18+ (TypeScript)
- **Web Framework:** Express 5
- **RPC Client:** starknet.js v8.9.1
- **Persistence:** File-based JSON state (simple, no external dependencies)
- **Metrics:** OpenTelemetry (optional, disabled by default)
- **Containerization:** Docker + Kubernetes (Helm)

---

## Quick Commands

```bash
# Development
npm install          # Install dependencies
npm run dev          # Run with ts-node (hot reload)
npm run check        # TypeScript type checking
npm run lint         # ESLint
npm run format       # Prettier

# Production
npm run build        # Compile to dist/
npm start            # Run compiled JS

# Docker
docker build -t replay-service .
./build-and-push.sh  # Build and push to ECR
```

---

## Directory Structure

```
src/
├── index.ts                    # Express server, health endpoint, recovery on startup
├── config.ts                   # Singleton config with env validation
├── constants.ts                # Retry limits, timeouts, tx types
├── types.ts                    # TypeScript interfaces (SyncState, SyncProcess, etc.)
├── logger.ts                   # Winston logging
├── providers.ts                # RPC provider factory (v0.8.1 & v0.9.0)
├── persistence.ts              # File-based state management (sync-state.json)
├── sync.ts                     # Main sync logic and API endpoints
│
├── api/                        # API response formatting
├── errors/                     # Custom error classes
├── retry/                      # Retry strategies (exponential, fixed, linear)
├── operations/                 # RPC operations (block, transaction)
├── madara/                     # Madara health & recovery
├── state/                      # SyncStateManager singleton
├── probe/                      # Continuous sync monitoring (60s interval)
├── validation/                 # Block readiness validation
├── sync/                       # Block & Transaction processors
├── transactions/               # TX type handlers (invoke, declare, deploy_account, l1_handler)
└── telemetry/                  # OpenTelemetry integration
```

---

## Key Concepts

### Sync Mode
The service sends transactions sequentially with a small delay, then validates all receipts in parallel. This provides a good balance of speed and reliability.

### Continuous Sync
When `endBlock: "latest"`, the service:
- Syncs to current latest block
- Starts probe loop (every 60s)
- Automatically updates target as source advances
- "Fire and forget" operation

### State File (sync-state.json)
The service uses a simple JSON file for persistence:
```json
{
  "status": "running",      // "running" | "idle"
  "syncTo": "latest",       // target block or "latest"
  "isContinuous": true,
  "updatedAt": "2025-12-16T..."
}
```

### Recovery on Startup (K8s Pod Restart)
When the service starts:
1. Check if state file exists
2. If `status: "running"`:
   - Query syncing node for latest block N
   - Query original node for same block N
   - **Validate both `block_hash` and `parent_hash` match**
   - If match: resume from block N+1
   - If mismatch: **exit with error code 1** (triggers CrashLoopBackoff)
3. If no file or `status: "idle"`: wait for RPC call

### Madara Recovery
- Detects when Madara is unreachable
- Exponential backoff retry (max 24 hours)
- Automatically resumes sync after recovery

---

## Environment Variables

### Required
```bash
RPC_URL_ORIGINAL_NODE=https://...      # Source Starknet node
RPC_URL_SYNCING_NODE=http://...        # Destination Madara node
ADMIN_RPC_URL_SYNCING_NODE=http://...  # Madara admin RPC
```

### Optional
```bash
PORT=3000
NODE_ENV=development|production
STATE_FILE_PATH=./sync-state.json      # Path to state file
CLEAN_SLATE=false                       # Clear state file on startup

# OpenTelemetry
OTEL_ENABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=transaction-replay-service
```

---

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check + sync status |
| POST | `/sync` | Start sync `{endBlock: number\|"latest"}` |
| POST | `/sync/cancel` | Cancel sync |
| GET | `/sync/status` | Current sync process status |

---

## Transaction Types Supported

| Type | Versions | Handler File |
|------|----------|--------------|
| INVOKE | 0x0, 0x1, 0x3 | `transactions/invoke.ts` |
| DECLARE | 0x0, 0x1, 0x2, 0x3 | `transactions/declare.ts` |
| DEPLOY_ACCOUNT | All | `transactions/deploy_account.ts` |
| L1_HANDLER | N/A | `transactions/l1_handler.ts` |

---

## Key Constants (src/constants.ts)

```typescript
// Retry Limits
MAX_RETRIES_BLOCK_FETCH: 8
MAX_RETRIES_RECEIPT_VALIDATION: 20
MAX_RETRIES_RECEIPT_VALIDATION_PARALLEL: 2000
MAX_RETRIES_BLOCK_HASH: 100
MAX_RETRIES_TRANSACTION_POST: 3

// Timeouts
MADARA_RECOVERY_MAX_WAIT: 24 hours
PROBE_INTERVAL: 60 seconds

// Delays
TX_DELAY_BETWEEN_TXS: 100ms
TX_DELAY_FIRST_RECEIPT: 2000ms
```

---

## Error Classes (src/errors/)

- `AppError` - Base error
- `MadaraDownError` - Madara unreachable (503)
- `ConfigurationError` - Invalid config (500)
- `SyncInProgressError` - Already syncing (409)
- `InvalidBlockError` - Bad block number (400)
- `BlockHashMismatchError` - Hash verification failed (causes exit with code 1)
- `ProcessNotFoundError` - Process not found (404)

---

## Common Tasks

### Adding a New Transaction Type
1. Create handler in `src/transactions/`
2. Add type to `TRANSACTION_TYPES` in `constants.ts`
3. Update `processTx` dispatcher in `transactions/index.ts`

### Modifying Retry Behavior
- Strategies: `src/retry/strategies.ts`
- Pre-configured executors: `src/retry/index.ts`

### Adding New Metrics
1. Define metric in `src/telemetry/metrics.ts`
2. Record at appropriate points in code
3. Document in `docs/METRICS.md`

### Changing Sync Logic
- Block processing: `src/sync/BlockProcessor.ts`
- Transaction processing: `src/sync/TransactionProcessor.ts`
- Main flow: `src/sync.ts`

---

## Architecture Notes

### Singleton Patterns Used
- `Config` - Configuration management
- `SyncStateManager` - In-memory process state
- `PersistenceLayer` - File-based state

### RPC Versions
The service maintains two provider versions:
- `v0.8.1` - `/rpc/v0_8_1`
- `v0.9.0` - `/rpc/v0_9`

### State Management
- **File (sync-state.json)**: Persistent intent (should we be syncing?)
- **SyncStateManager**: In-memory state (current execution details)
- **Syncing Node**: Source of truth for current position (queried on recovery)

### Recovery Design Philosophy
- State file only tracks **intent** (are we supposed to be syncing?)
- Actual position is recovered from syncing node
- Chain integrity validated before resuming
- Hash mismatch = fatal error (exit 1, CrashLoopBackoff)

---

## Deployment

### Helm Charts
Located in `/helm/`:
- `values.yaml` - Base configuration
- `values-paradex-mainnet.yaml`
- `values-paradex-testnet.yaml`
- `values-paradex-mock-network.yaml`

### Docker Image
Published to: `public.ecr.aws/o5q6k5w4/karnot-operator/txn_replay_service`

### K8s State File
Configure `STATE_FILE_PATH` in ConfigMap. Default: `/data/sync-state.json`

---

## Documentation

- `/docs/METRICS.md` - OpenTelemetry metrics reference
- `/docs/GRAFANA_DASHBOARD.md` - Grafana setup
- `/docs/OTEL_SETUP.md` - OpenTelemetry configuration

---

## Recent Changes

- **Removed Redis dependency** - Replaced with simple file-based state
- **Simplified codebase** - Removed old sequential sync, kept only parallel receipt validation
- **Renamed snapSync to sync** - Cleaner naming throughout
- **Improved recovery** - Validates chain integrity (block_hash + parent_hash) on startup
- **K8s-friendly** - Hash mismatch triggers exit(1) for CrashLoopBackoff alerts

---

## Tips for Development

1. **Always read existing code** before making changes
2. **Use the retry framework** for any network operations
3. **Update metrics** when adding new observable behavior
4. **Wrap Madara calls** with `executeWithMadaraRecovery` for resilience
5. **Test with CLEAN_SLATE=true** to reset state during development
6. **Check constants.ts** for tunable parameters
7. **State file is minimal** - syncing node is source of truth for position

---

*Last updated: 2025-12-16*
