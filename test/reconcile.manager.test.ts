import test from "node:test";
import assert from "node:assert/strict";
import { ReconcileManager } from "../src/reconcile/ReconcileManager.js";
import type {
  ReconcileOps,
  ReconcileStateStore,
  ReconcileSyncController,
} from "../src/reconcile/ReconcileManager.js";
import type { SyncState } from "../src/types.js";

interface Harness {
  manager: ReconcileManager;
  calls: {
    localBlocks: number[];
    sourceBlocks: number[];
    reverts: string[];
    starts: Array<{ endBlock: number | "latest"; options?: { startBlock?: number; skipReconcile?: boolean } }>;
    stopRequests: number;
  };
  state: SyncState;
  localBlocks: Map<number, any>;
  sourceBlocks: Map<number, any>;
  setLocalHead(blockNumber: number): void;
}

function createBlock(hash: string, txCount: number) {
  return {
    block_hash: hash,
    transactions: Array.from({ length: txCount }, (_, index) => `0x${hash}-${index}`),
  };
}

function createHarness(options?: {
  localHead?: number;
  state?: Partial<SyncState>;
  activeProcess?: boolean;
  localBlocks?: Map<number, any>;
  sourceBlocks?: Map<number, any>;
  onRevert?: (hash: string, harness: Harness) => Promise<void> | void;
  getLocalHead?: () => Promise<number>;
  getSourceBlock?: (blockNumber: number, harness: Harness) => Promise<any>;
  getLocalBlock?: (blockNumber: number, harness: Harness) => Promise<any>;
}) {
  let localHead = options?.localHead ?? 0;
  let activeProcess = options?.activeProcess ?? false;
  const localBlocks = options?.localBlocks ?? new Map<number, any>();
  const sourceBlocks = options?.sourceBlocks ?? new Map<number, any>();
  const calls = {
    localBlocks: [] as number[],
    sourceBlocks: [] as number[],
    reverts: [] as string[],
    starts: [] as Array<{
      endBlock: number | "latest";
      options?: { startBlock?: number; skipReconcile?: boolean };
    }>,
    stopRequests: 0,
  };

  let state: SyncState = {
    status: "idle",
    syncTo: null,
    isContinuous: false,
    currentBlock: null,
    lastVerifiedBlock: null,
    lastVerifiedHash: null,
    resumeAfterReconcile: false,
    updatedAt: new Date().toISOString(),
    ...options?.state,
  };

  const harness = {} as Harness;

  const ops: ReconcileOps = {
    getLocalHead: options?.getLocalHead ?? (async () => localHead),
    getLocalBlock:
      (async (blockNumber: number) => {
        if (options?.getLocalBlock) {
          return options.getLocalBlock(blockNumber, harness);
        }

        calls.localBlocks.push(blockNumber);
        if (!localBlocks.has(blockNumber)) {
          throw new Error(`missing local block ${blockNumber}`);
        }
        return localBlocks.get(blockNumber);
      }),
    getSourceBlock:
      (async (blockNumber: number) => {
        if (options?.getSourceBlock) {
          return options.getSourceBlock(blockNumber, harness);
        }

        calls.sourceBlocks.push(blockNumber);
        if (!sourceBlocks.has(blockNumber)) {
          throw new Error(`missing source block ${blockNumber}`);
        }
        return sourceBlocks.get(blockNumber);
      }),
    revertToAndShutdown: async (hash: string) => {
      calls.reverts.push(hash);
      if (options?.onRevert) {
        await options.onRevert(hash, harness);
      }
    },
    waitForMadaraRecovery: async () => true,
  };

  const stateStore: ReconcileStateStore = {
    readState: () => state,
    shouldAutoResumeOnStartup: () =>
      state.status === "running" || (state.status === "reconciling" && state.resumeAfterReconcile),
    patchState: (patch: Partial<SyncState>) => {
      state = {
        ...state,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      harness.state = state;
      return state;
    },
    markReconciling: (resumeAfterReconcile: boolean) => {
      state = {
        ...state,
        status: "reconciling",
        resumeAfterReconcile,
        updatedAt: new Date().toISOString(),
      };
      harness.state = state;
    },
    markReconcileFailed: (resumeAfterReconcile: boolean) => {
      state = {
        ...state,
        status: "reconcile_failed",
        resumeAfterReconcile,
        updatedAt: new Date().toISOString(),
      };
      harness.state = state;
    },
    restoreIdleAfterReconcile: () => {
      state = {
        ...state,
        status: "idle",
        syncTo: null,
        isContinuous: false,
        resumeAfterReconcile: false,
        updatedAt: new Date().toISOString(),
      };
      harness.state = state;
    },
    getIntendedTarget: () => ({
      syncTo: state.syncTo,
      isContinuous: state.isContinuous,
      resumeAfterReconcile: state.resumeAfterReconcile,
      status: state.status,
    }),
  };

  const syncController: ReconcileSyncController = {
    hasActiveProcess: () => activeProcess,
    requestReconcileStop: () => {
      calls.stopRequests += 1;
      activeProcess = false;
      return true;
    },
    waitForRunToFinish: async () => {},
  };

  const manager = new ReconcileManager(
    120_000,
    ops,
    stateStore,
    syncController,
  );
  manager.registerStartSyncHandler(async (endBlock, startOptions) => {
    calls.starts.push({
      endBlock: endBlock as number | "latest",
      options: startOptions,
    });
  });

  Object.assign(harness, {
    manager,
    calls,
    state,
    localBlocks,
    sourceBlocks,
    setLocalHead(blockNumber: number) {
      localHead = blockNumber;
    },
  });

  return harness;
}

test("scheduled reconcile does nothing when the confirmed head is sane and idle", async () => {
  const harness = createHarness({
    localHead: 12,
    localBlocks: new Map([
      [10, createBlock("0x10", 1)],
      [11, createBlock("0x11", 0)],
      [12, createBlock("0x12", 2)],
    ]),
    sourceBlocks: new Map([
      [10, createBlock("0x10", 1)],
      [11, createBlock("0x11", 0)],
      [12, createBlock("0x12", 2)],
    ]),
  });

  const result = await harness.manager.ensureHealthyHead({ trigger: "scheduled" });

  assert.equal(result.status, "healthy");
  assert.equal(harness.calls.reverts.length, 0);
  assert.equal(harness.calls.starts.length, 0);
  assert.equal(harness.calls.stopRequests, 0);
});

test("scheduled reconcile repairs a dirty idle lane without auto-restarting replay", async () => {
  const harness = createHarness({
    localHead: 22,
    localBlocks: new Map([
      [20, createBlock("0x20", 1)],
      [21, createBlock("0x21", 1)],
      [22, createBlock("0x22-local", 0)],
    ]),
    sourceBlocks: new Map([
      [20, createBlock("0x20", 1)],
      [21, createBlock("0x21", 1)],
      [22, createBlock("0x22-source", 0)],
    ]),
    onRevert: (_hash, currentHarness) => {
      currentHarness.setLocalHead(21);
    },
  });

  const result = await harness.manager.ensureHealthyHead({ trigger: "scheduled" });

  assert.equal(result.status, "repaired");
  assert.deepEqual(harness.calls.reverts, ["0x21"]);
  assert.equal(harness.calls.starts.length, 0);
  assert.equal(harness.state.status, "idle");
});

test("scheduled reconcile force-stops active replay, repairs, and auto-restarts", async () => {
  const harness = createHarness({
    localHead: 32,
    activeProcess: true,
    state: {
      status: "running",
      syncTo: "latest",
      isContinuous: true,
    },
    localBlocks: new Map([
      [30, createBlock("0x30", 1)],
      [31, createBlock("0x31", 2)],
      [32, createBlock("0x32-local", 0)],
    ]),
    sourceBlocks: new Map([
      [30, createBlock("0x30", 1)],
      [31, createBlock("0x31", 2)],
      [32, createBlock("0x32-source", 0)],
    ]),
    onRevert: (_hash, currentHarness) => {
      currentHarness.setLocalHead(31);
    },
  });

  const result = await harness.manager.ensureHealthyHead({ trigger: "scheduled" });

  assert.equal(result.status, "repaired");
  assert.equal(harness.calls.stopRequests, 1);
  assert.deepEqual(harness.calls.reverts, ["0x31"]);
  assert.equal(harness.calls.starts.length, 1);
  assert.equal(harness.calls.starts[0].endBlock, "latest");
  assert.equal(harness.calls.starts[0].options?.startBlock, 32);
});

test("source unreachability defers reconcile without stopping active replay", async () => {
  const harness = createHarness({
    localHead: 42,
    activeProcess: true,
    state: {
      status: "running",
      syncTo: "latest",
      isContinuous: true,
    },
    localBlocks: new Map([
      [40, createBlock("0x40", 1)],
      [41, createBlock("0x41", 1)],
      [42, createBlock("0x42", 1)],
    ]),
    sourceBlocks: new Map(),
    getSourceBlock: async (blockNumber: number) => {
      throw new Error(`source unavailable at ${blockNumber}`);
    },
  });

  const result = await harness.manager.ensureHealthyHead({ trigger: "scheduled" });

  assert.equal(result.status, "deferred");
  assert.equal(harness.calls.stopRequests, 0);
  assert.equal(harness.calls.reverts.length, 0);
});

test("scheduled reconcile still runs after reconcile_failed and can restart intended sync", async () => {
  const harness = createHarness({
    localHead: 91,
    state: {
      status: "reconcile_failed",
      syncTo: "latest",
      isContinuous: true,
      resumeAfterReconcile: true,
    },
    localBlocks: new Map([
      [89, createBlock("0x89", 1)],
      [90, createBlock("0x90", 1)],
      [91, createBlock("0x91-local", 0)],
    ]),
    sourceBlocks: new Map([
      [89, createBlock("0x89", 1)],
      [90, createBlock("0x90", 1)],
      [91, createBlock("0x91-source", 0)],
    ]),
    onRevert: (_hash, currentHarness) => {
      currentHarness.setLocalHead(90);
    },
  });

  const result = await harness.manager.ensureHealthyHead({ trigger: "scheduled" });

  assert.equal(result.status, "repaired");
  assert.deepEqual(harness.calls.reverts, ["0x90"]);
  assert.equal(harness.calls.starts.length, 1);
  assert.equal(harness.calls.starts[0].endBlock, "latest");
  assert.equal(harness.calls.starts[0].options?.startBlock, 91);
});

test("startup recovery reuses reconcile logic and restarts from the reconciled boundary", async () => {
  const harness = createHarness({
    localHead: 52,
    state: {
      status: "running",
      syncTo: 999,
      isContinuous: false,
      currentBlock: 53,
    },
    localBlocks: new Map([
      [50, createBlock("0x50", 1)],
      [51, createBlock("0x51", 1)],
      [52, createBlock("0x52", 1)],
    ]),
    sourceBlocks: new Map([
      [50, createBlock("0x50", 1)],
      [51, createBlock("0x51", 1)],
      [52, createBlock("0x52", 1)],
    ]),
  });

  await harness.manager.recoverOnStartup();

  assert.equal(harness.calls.reverts.length, 0);
  assert.equal(harness.calls.starts.length, 1);
  assert.equal(harness.calls.starts[0].endBlock, 999);
  assert.equal(harness.calls.starts[0].options?.startBlock, 53);
});

test("runtime faults use inline reconcile without stop or restart", async () => {
  const harness = createHarness({
    localHead: 62,
    state: {
      status: "running",
      syncTo: "latest",
      isContinuous: true,
    },
    localBlocks: new Map([
      [60, createBlock("0x60", 1)],
      [61, createBlock("0x61", 0)],
      [62, createBlock("0x62-local", 0)],
    ]),
    sourceBlocks: new Map([
      [60, createBlock("0x60", 1)],
      [61, createBlock("0x61", 0)],
      [62, createBlock("0x62-source", 0)],
    ]),
    onRevert: (_hash, currentHarness) => {
      currentHarness.setLocalHead(61);
    },
  });

  const result = await harness.manager.handleRuntimeFault(62);

  assert.equal(result.status, "repaired");
  assert.equal(result.resumeFrom, 62);
  assert.equal(harness.calls.stopRequests, 0);
  assert.equal(harness.calls.starts.length, 0);
});

test("scheduled reconcile extends the scan window from 3 to 5 blocks when needed", async () => {
  const harness = createHarness({
    localHead: 70,
    localBlocks: new Map([
      [66, createBlock("0x66", 1)],
      [67, createBlock("0x67", 1)],
      [68, createBlock("0x68-local", 1)],
      [69, createBlock("0x69-local", 1)],
      [70, createBlock("0x70-local", 1)],
    ]),
    sourceBlocks: new Map([
      [66, createBlock("0x66", 1)],
      [67, createBlock("0x67", 1)],
      [68, createBlock("0x68-source", 1)],
      [69, createBlock("0x69-source", 1)],
      [70, createBlock("0x70-source", 1)],
    ]),
    onRevert: (_hash, currentHarness) => {
      currentHarness.setLocalHead(67);
    },
  });

  const result = await harness.manager.ensureHealthyHead({ trigger: "scheduled" });

  assert.equal(result.status, "repaired");
  assert.deepEqual(harness.calls.reverts, ["0x67"]);
  assert.deepEqual(harness.calls.localBlocks, [68, 69, 70, 66, 67, 68, 69, 70, 67]);
});

test("scheduled reconcile extends a repairable boundary to keep a deeper retry available", async () => {
  const harness = createHarness({
    localHead: 53,
    localBlocks: new Map([
      [49, createBlock("0x49", 1)],
      [50, createBlock("0x50", 0)],
      [51, createBlock("0x51", 2)],
      [52, createBlock("0x52-local", 0)],
      [53, createBlock("0x53-local", 1)],
    ]),
    sourceBlocks: new Map([
      [49, createBlock("0x49", 1)],
      [50, createBlock("0x50", 0)],
      [51, createBlock("0x51", 2)],
      [52, createBlock("0x52-source", 0)],
      [53, createBlock("0x53-source", 1)],
    ]),
    onRevert: (hash, currentHarness) => {
      if (hash === "0x51") {
        currentHarness.setLocalHead(52);
        return;
      }

      if (hash === "0x50") {
        currentHarness.setLocalHead(50);
      }
    },
  });

  const result = await harness.manager.ensureHealthyHead({ trigger: "scheduled" });

  assert.equal(result.status, "repaired");
  assert.deepEqual(harness.calls.reverts, ["0x51", "0x50"]);
  assert.equal(result.resumeFrom, 51);
  assert.ok(harness.calls.localBlocks.includes(49));
  assert.ok(harness.calls.sourceBlocks.includes(49));
});

test("reconcile performs exactly one one-block-deeper retry when the first repair is insufficient", async () => {
  let revertAttempt = 0;
  const harness = createHarness({
    localHead: 80,
    localBlocks: new Map([
      [76, createBlock("0x76", 1)],
      [77, createBlock("0x77", 1)],
      [78, createBlock("0x78", 1)],
      [79, createBlock("0x79", 1)],
      [80, createBlock("0x80-local", 0)],
    ]),
    sourceBlocks: new Map([
      [76, createBlock("0x76", 1)],
      [77, createBlock("0x77", 1)],
      [78, createBlock("0x78", 1)],
      [79, createBlock("0x79", 1)],
      [80, createBlock("0x80-source", 0)],
    ]),
    onRevert: (_hash, currentHarness) => {
      revertAttempt += 1;
      if (revertAttempt === 1) {
        currentHarness.setLocalHead(80);
        currentHarness.localBlocks.set(80, createBlock("0x80-still-bad", 0));
        return;
      }

      currentHarness.setLocalHead(78);
    },
  });

  const result = await harness.manager.ensureHealthyHead({ trigger: "scheduled" });

  assert.equal(result.status, "repaired");
  assert.deepEqual(harness.calls.reverts, ["0x79", "0x78"]);
});

test("concurrent scheduled ticks skip when a reconcile is already in flight", async () => {
  let releaseHeadRead: () => void = () => {};
  const headRead = new Promise<void>((resolve) => {
    releaseHeadRead = resolve;
  });

  const harness = createHarness({
    localBlocks: new Map(),
    sourceBlocks: new Map(),
    getLocalHead: async () => {
      await headRead;
      return 0;
    },
  });

  const first = harness.manager.ensureHealthyHead({ trigger: "scheduled" });
  const second = await harness.manager.ensureHealthyHead({
    trigger: "scheduled",
    skipIfRunning: true,
  });

  assert.equal(second.status, "skipped");
  releaseHeadRead();
  await first;
});
