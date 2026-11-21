# Local committed-data replay

This is an isolated transaction-level C1 -> C2 replay exercise. Both Madara nodes use the published PR #1349 image at commit `5f78283bd01c709a8d21f5cf7666565857729668`, a fresh local devnet database, and the same local chain ID. C1 does not enable committed-data reads. C2 does. Neither node connects to PC Mainnet or its database.

The fixture has one legacy price slot, one committed root slot, and a `settle(a, b)` method that stores `a + b + price`. C1 leaves the fixture's committed read mode off. After the deployment transaction has replayed, C2 enables that mode with devnet account #2. Account #1 is the shared executor: it signs the legacy tick, root update, and settle transactions in nonce order on C1. The same signatures are submitted to C2. The separate C2 toggle never changes account #1's nonce.

## Run

From this repository worktree:

```sh
npm ci --no-audit --no-fund
cd examples/local-committed-data/fixture && scarb build && cd ../..
./examples/local-committed-data/start-local.sh
node examples/local-committed-data/producer.mjs
node examples/local-committed-data/replay.mjs
```

Wait until both public RPC ports answer before running the producer. `start-local.sh` starts local MongoDB because PR #1349 requires an external backup service before its private committed-data RPC can be enabled. Docker Desktop must be running. The image is x86_64 and runs under emulation on an arm64 Mac. `stop-local.sh` stops the three containers and retains their databases.

The producer declares and deploys the simple Cairo contract on C1. For prices 42 and 43 it sends a legacy tick, then imports a one-entry committed dataset and submits the signed root-update transaction through `madara_V0_1_0_importCommittedDataAndSubmitTransaction`, then sends a settle. Its `run.json` records the source start block, contract, and transaction hashes.

The replay process reads C1 blocks in order, imports unseen datasets from C1's feeder gateway into C2's private RPC, and broadcasts each signed transaction to C2. It also fetches the class for a `DECLARE` transaction. `--follow` keeps polling for new blocks. `checkpoint.json` saves the last completed source block for restart.

To continue sending new price rounds and replaying in the background after the first run, use two terminal sessions:

```sh
node examples/local-committed-data/producer.mjs --continue --follow
node examples/local-committed-data/replay.mjs --follow
```

The current laptop run uses `tmux` sessions `local-c1-producer` and `local-c2-replay`, with logs in workspace `context/build-logs/local-c1-producer.log` and `context/build-logs/local-c2-replay.log`. `stop-local.sh` stops these sessions and all three containers while retaining local volumes.

For each transaction the replay checks that the hash and execution status match. For each settle it compares contract event keys, price, and arithmetic result while requiring the C1 event to mark legacy mode and the C2 event to mark committed mode. The observed two-round run produced price/result `42/47` and `43/48` on both chains with mode `0` on C1 and `1` on C2.

## Scope

This tests signed transaction forwarding, off-chain dataset transfer, ordering, the C2-only contract toggle, and event-level business outcomes. It deliberately does not preserve C1 block numbers, headers, timestamps, or block hashes. Madara PR #1321 supplies a zero-hash opt-out for a managed-block path, but PR #1349's published image does not include that managed `replayBlock` RPC. A block-exact production replay requires a Madara image that combines those changes and further integration into the managed replay path.

The local account keys are read from Madara's devnet startup logs; they are only for this fixture. The producer sends to C1 only. C2 learns datasets and transactions from C1 and receives the one deliberate local toggle from devnet account #2.

## Whole-block managed replay

`start-managed-local.sh` starts a separate fresh pair: C1 runs the #1349 image, and C2 runs the combined #1349 + #1321 + managed-RPC image from Madara PR #1359 in paused-mempool replay mode. Its image defaults to `ghcr.io/madara-alliance/madara:manual-780f287`. C1 uses ports 39944/39943/39945/38080; C2 uses 49944/49943/49945/48080. Both block timers are set to one day so only the producer or managed replay closes blocks during this exercise. Set `C1_ONLY=true` to start C1 while the C2 image downloads, then run the script again to start C2. This test replays from both local genesis blocks, which can have different timestamps and hashes. The managed service sends C1's timestamp and gas prices for each later block and validates them from C2's confirmed block response. The source producer's `--batch` option submits an oracle round together in one C1 block.

```sh
./examples/local-committed-data/start-managed-local.sh
C1_CONTAINER=local-managed-c1 C1_RPC=http://127.0.0.1:39944/rpc/v0.10.2/ \
  C1_PRIVATE_RPC=http://127.0.0.1:39945/rpc/v0.1.0/ \
  C1_ADMIN_RPC=http://127.0.0.1:39943/rpc/v0.1.0/ \
  RUN_FILE=./examples/local-committed-data/managed-run.json \
  node examples/local-committed-data/producer.mjs --batch

# In another terminal, from this repository worktree:
REPLAY_MODE=managed_blocks VALIDATE_BLOCK_HASH=false REPLAY_BLOCK_RPC_ENABLED=true \
  MANAGED_BLOCK_MAX_INFLIGHT=1 MAX_SUPPORTED_STARKNET_VERSION=0.14.2 \
  RPC_URL_ORIGINAL_NODE=http://127.0.0.1:39944/rpc/v0.10.2/ \
  RPC_URL_SYNCING_NODE=http://127.0.0.1:49944/rpc/v0.10.2/ \
  ADMIN_RPC_URL_SYNCING_NODE=http://127.0.0.1:49943/rpc/v0.1.0/ \
  COMMITTED_DATA_REPLAY_ENABLED=true \
  COMMITTED_DATA_SOURCE_FEEDER_URL=http://127.0.0.1:38080/feeder_gateway \
  COMMITTED_DATA_TARGET_RPC_URL=http://127.0.0.1:49945/rpc/v0.1.0/ \
  REPLAY_EVENT_CONTRACT_ADDRESS=$(jq -r .contract examples/local-committed-data/managed-run.json) \
  STATE_FILE_PATH=/tmp/local-managed-replay-state.json PORT=3001 node dist/index.js
curl -s -X POST http://127.0.0.1:3001/sync -H 'content-type: application/json' \
  -d '{"startBlock":1,"endBlock":4}'
```

The verified local run replayed one declare block, one deploy block, and two three-transaction oracle rounds. All eight transactions succeeded. C1 and C2 had the same timestamps, gas prices, transaction counts/order, receipt outcomes, and settle events; all four block hashes differed. Replaying already confirmed block 4 again returned its original C2 hash and passed validation. Both C1 and C2 feeder gateways exposed the same two committed-data roots.

This first managed-block run keeps the fixture's read mode at legacy on both chains while proving block metadata and boundaries. The earlier transaction-level run proves the C2 committed-read path. The divergent managed run below establishes an aligned fork boundary and then proves both properties together.

### Twenty-block stress run

With fresh `local-managed-c1` and `local-managed-c2` databases, run the producer above with `--stress-blocks=20` instead of `--batch`. It declares/deploys the fixture in blocks 1-2, then creates blocks 3-22 with a random 7-33 rounds per block. Each round has one legacy tick, one committed root update, and one settle, so every stress block has an exactly equal 1:1:1 mix and 21-99 transactions. If the producer stops after a completed block, resume with `--continue --stress-blocks=20`.

Start the replay service with the same environment as above and call `/sync` with `{"startBlock":1,"endBlock":22}`. Then check the result independently:

```sh
C1_RPC=http://127.0.0.1:39944/rpc/v0.10.2/ \
  C2_RPC=http://127.0.0.1:49944/rpc/v0.10.2/ \
  node examples/local-committed-data/verify-stress.mjs
```

The 21 November stress run produced 1,128 transactions across 20 blocks, exactly 376 of each operation, with block sizes from 21 to 99. The replay service completed blocks 1-22 in 3.99 seconds. The independent verifier checked every stress block's metadata, transaction payload/order, successful receipts, and events; all matched despite different C1/C2 block hashes. Both feeder gateways exposed the same 376 committed-data roots.

### Divergent oracle reads across 20 managed blocks

This run proves that C1 settles using its legacy tick while C2 settles using its committed dataset. Start with fresh local databases and run `C2_BOOTSTRAP=true ./examples/local-committed-data/start-managed-local.sh`. Produce C1 traffic with the same C1 environment shown above, plus `RUN_FILE=./examples/local-committed-data/divergent-run.json LEGACY_PRICE_OFFSET=1000`, and invoke `producer.mjs --stress-blocks=20 --fork-boundary`. The committed dataset holds price `P`, while the signed legacy tick sets `P + 1000`. C1 blocks 1-2 declare/deploy the fixture, block 3 is an empty fork boundary, and blocks 4-23 contain the 20 balanced oracle rounds.

Before switching C2 to managed mode, mirror the declaration and deployment and enable committed reads on C2:

```sh
RUN_FILE=./examples/local-committed-data/divergent-run.json \
  C1_RPC=http://127.0.0.1:39944/rpc/v0.10.2/ \
  C2_RPC=http://127.0.0.1:49944/rpc/v0.10.2/ \
  node examples/local-committed-data/bootstrap-c2-committed.mjs
docker stop local-managed-c2
docker rm local-managed-c2
./examples/local-committed-data/start-managed-local.sh
```

C2 block 3 contains the one C2-only enable transaction. The same account signs all tick/root/settle transactions in blocks 4-23 on both chains; account #2 signs only the C2 boundary transaction. Start the replay service with the managed environment above, using `REPLAY_EVENT_DATA_PREFIX_LENGTH=0`, without `REPLAY_EVENT_CONTRACT_ADDRESS`, and with a fresh state-file path. This compares event count/order/origin/keys and receipts while allowing intentionally different event data and fee amounts. Call `/sync` with `{"startBlock":4,"endBlock":23}`. Then run:

```sh
RUN_FILE=./examples/local-committed-data/divergent-run.json \
  C1_RPC=http://127.0.0.1:39944/rpc/v0.10.2/ \
  C2_RPC=http://127.0.0.1:49944/rpc/v0.10.2/ \
  node examples/local-committed-data/verify-stress.mjs
```

The verifier checks every settle event against its signed legacy tick and C2 committed dataset: C1 must emit `(P+1000, P+1005, 0)` and C2 must emit `(P, P+5, 1)`. It also checks every root/value page on C2, exact signed transaction payload/order, block metadata, receipt success, and the deliberate boundary difference. The verified 21 November run contained 1,320 transactions across the 20 post-boundary blocks, 440 of each operation. The first settle was C1 `(1042, 1047, 0)` and C2 `(42, 47, 1)`.
