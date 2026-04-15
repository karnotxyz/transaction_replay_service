# Transaction Replay Service

A robust service for synchronizing Starknet blocks between nodes with support for sequential and parallel transaction processing.

## Features

- **Sequential Sync**: Transaction-by-transaction synchronization with transaction-level resumability
- **Continuous Sync**: Automatically follow new blocks as they arrive
- **Auto-Resume**: Automatically resume interrupted sync processes on restart
- **Madara Recovery**: Automatic detection and recovery from Madara node downtime
- **Clean Slate**: Option to start fresh by clearing all sync state

## Architecture

### Directory Structure

```
src/
├── config.ts              # Configuration management
├── constants.ts           # Application constants
├── types.ts              # TypeScript type definitions
├── logger.ts             # Logging configuration
├── persistence.ts        # Redis persistence layer
├── providers.ts          # RPC provider configuration
├── index.ts              # Application entry point
│
├── errors/               # Error handling
│   └── index.ts          # Custom error classes
│
├── retry/                # Retry logic
│   ├── strategies.ts     # Retry strategies
│   ├── executor.ts       # Retry executor
│   └── index.ts          # Pre-configured retry instances
│
├── operations/           # RPC operations
│   ├── blockOperations.ts
│   ├── transactionOperations.ts
│   └── index.ts
│
├── madara/               # Madara-specific functionality
│   ├── health.ts         # Health checking and recovery
│   └── index.ts
│
├── state/                # State management
│   ├── SyncStateManager.ts
│   └── index.ts
│
├── probe/                # Continuous sync probing
│   ├── ProbeManager.ts
│   └── index.ts
│
├── validation/           # Validation logic
│   ├── blockValidator.ts
│   └── index.ts
│
└── transactions/         # Transaction handlers
    ├── index.ts
    ├── invoke.ts
    ├── declare.ts
    ├── deploy_account.ts
    └── l1_handler.ts
```

## Configuration

### Required Environment Variables

```bash
# RPC Endpoints
RPC_URL_ORIGINAL_NODE=<original_node_url>
RPC_URL_SYNCING_NODE=<syncing_node_url>
ADMIN_RPC_URL_SYNCING_NODE=<admin_rpc_url>

# Optional
PORT=3000
NODE_ENV=development
STATE_FILE_PATH=./sync-state.json
CLEAN_SLATE=false
MAX_SUPPORTED_STARKNET_VERSION=0.14.1
LOG_LEVEL=info
```

### Configuration Features

- **Type-safe configuration**: All config values are validated on startup
- **URL validation**: Ensures all RPC URLs are valid
- **Sensible defaults**: Falls back to defaults for optional values
- **Protocol guard**: Can stop replay before processing blocks above a configured Starknet version
- **Masked logging**: Sensitive data is masked in logs

## API Endpoints

### Health Check

```
GET /health
```

Returns service health status and active processes.

### Sequential Sync

```
POST /sync
Body: { "endBlock": <number|"latest"> }
```

Start sequential sync process. Use `"latest"` for continuous sync.

```
POST /sync/cancel/:processId
Body: { "complete_current_block": <boolean> }
```

Cancel a specific sync process.

```
POST /sync/cancel
Body: { "complete_current_block": <boolean> }
```

Cancel current running sync process.

### Snap Sync (Parallel)

```
POST /snap_sync
Body: { "endBlock": <number|"latest"> }
```

Start snap sync with parallel transaction processing.

```
POST /snap_sync/cancel
```

Cancel current snap sync process.

```
GET /snap_sync/status
```

Get status of current snap sync process.

## Error Handling

### Error Classes

- **MadaraDownError**: Madara node is unreachable
- **ConfigurationError**: Invalid configuration
- **SyncInProgressError**: Sync already running
- **InvalidBlockError**: Invalid block number/identifier
- **BlockHashMismatchError**: Block hash verification failed
- **ProcessNotFoundError**: Process not found
- **InvalidProcessStatusError**: Invalid process status

### Error Detection

The service automatically detects various error conditions:

- Network errors (ECONNREFUSED, ENOTFOUND, etc.)
- Madara node downtime
- Configuration issues
- Block validation failures

## Retry Strategies

### Available Strategies

1. **Exponential Backoff**: Doubles delay on each retry (1s, 2s, 4s, 8s...)
2. **Fixed Delay**: Uses same delay for all retries
3. **Linear Backoff**: Linearly increases delay (1s, 2s, 3s, 4s...)
4. **No Retry**: Fails immediately

### Pre-configured Retries

- `blockFetchRetry`: Exponential backoff for block fetching
- `blockValidationRetry`: Exponential backoff for validation
- `receiptValidationRetry`: Fixed delay for receipts
- `parallelReceiptValidationRetry`: Higher retry count for parallel mode
- `blockHashRetry`: Exponential backoff for hash matching
- `transactionPostRetry`: Fixed delay for transaction posting

## Madara Recovery

The service includes automatic Madara recovery:

1. **Detection**: Automatically detects when Madara is down
2. **Wait**: Waits up to 24 hours for recovery with exponential backoff
3. **Verification**: Checks PRE_CONFIRMED block state after recovery
4. **Resume**: Intelligently resumes from correct point

### Recovery Behavior

- **Empty PRE_CONFIRMED**: Restarts block from beginning
- **Partial PRE_CONFIRMED**: Continues from last transaction
- **Hash Mismatch**: Fails immediately (non-retriable)

## Continuous Sync

Use `"latest"` as the `endBlock` to enable continuous sync:

```bash
curl -X POST http://localhost:3000/sync \
  -H "Content-Type: application/json" \
  -d '{"endBlock": "latest"}'
```

Features:

- Automatically probes for new blocks every 60 seconds
- Updates target dynamically as new blocks arrive
- Auto-resume on restart
- Works with both sequential and snap sync

## Development

### Build

```bash
npm run build
```

### Run

```bash
npm start
```

### Development Mode

```bash
npm run dev
```

### Type Check

```bash
npm run check
```

### Tests

```bash
npm test
npm run test:live-parser
```

`test:live-parser` defaults to `https://pathfinder-sepolia.d.karnot.xyz` and can be pointed elsewhere with `LIVE_STARKNET_RPC_URL`.

## Monitoring

### Logs

Logs include:

- Timestamps
- Log levels (info, warn, error, debug)
- Process IDs and correlation
- Emojis for quick scanning (configurable)

### Metrics

The service tracks:

- Blocks processed
- Transactions processed
- Success/failure rates
- Sync duration
- Recovery events

## Best Practices

1. **Always use continuous sync in production** to avoid falling behind
2. **Monitor Redis connection** - sync state depends on it
3. **Set appropriate retry limits** based on network reliability
4. **Use clean slate carefully** - only for testing or fresh starts
5. **Configure adequate Madara recovery time** for your infrastructure

## Troubleshooting

### Sync Not Starting

- Check Redis connection
- Verify RPC URLs are correct
- Ensure no other sync is running
- Check logs for configuration errors

### Madara Down Errors

- Verify Madara node is running
- Check network connectivity
- Review Madara logs
- Ensure admin RPC is accessible

### Block Hash Mismatch

- This is a critical error indicating data inconsistency
- Stop sync immediately
- Investigate block data on both nodes
- May require re-sync from earlier block

## License

ISC
