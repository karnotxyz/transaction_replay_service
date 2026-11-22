import assert from "node:assert/strict";
import test from "node:test";
import {
  MadaraDownError,
  SourceRpcUnavailableError,
  wrapMadaraError,
} from "../src/errors/index.js";
import { RetryExecutor, failFastOnMadaraDown } from "../src/retry/executor.js";
import { ExponentialBackoffStrategy } from "../src/retry/strategies.js";

const retryExecutor = (maxRetries: number) =>
  new RetryExecutor(
    new ExponentialBackoffStrategy(maxRetries, 0),
    failFastOnMadaraDown,
  );

test("retries a transient original/source RPC failure", async () => {
  let attempts = 0;

  const result = await retryExecutor(2).execute(async () => {
    attempts++;
    if (attempts === 1) {
      throw wrapMadaraError(
        new Error("fetch failed"),
        "getBlockWithTxHashes(42) [original]",
        "original",
      );
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("stops after bounded retries when the source RPC remains unavailable", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      retryExecutor(2).execute(async () => {
        attempts++;
        throw wrapMadaraError(
          new Error("fetch failed"),
          "getBlockWithTxHashes(42) [original]",
          "original",
        );
      }),
    SourceRpcUnavailableError,
  );

  assert.equal(attempts, 3);
});

test("fails fast when the syncing Madara is unavailable", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      retryExecutor(2).execute(async () => {
        attempts++;
        throw wrapMadaraError(
          new Error("fetch failed"),
          "getBlockWithTxHashes(42) [syncing]",
          "syncing",
        );
      }),
    MadaraDownError,
  );

  assert.equal(attempts, 1);
});
