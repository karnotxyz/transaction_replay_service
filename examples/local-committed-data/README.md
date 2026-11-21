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
