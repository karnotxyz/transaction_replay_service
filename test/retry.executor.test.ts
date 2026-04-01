import test from "node:test";
import assert from "node:assert/strict";
import { RetryExecutor } from "../src/retry/executor.js";
import { FixedDelayStrategy } from "../src/retry/strategies.js";
import { BlockAlignmentError } from "../src/errors/index.js";

test("RetryExecutor preserves typed errors when retries are exhausted", async () => {
  const executor = new RetryExecutor(new FixedDelayStrategy(2, 0));
  const terminalError = new BlockAlignmentError(8303490, 8303490);

  await assert.rejects(
    async () => {
      await executor.execute(async () => {
        throw terminalError;
      }, "validateBlock(8303490)");
    },
    (error: unknown) => {
      assert.equal(error, terminalError);
      assert.ok(error instanceof BlockAlignmentError);
      assert.match(
        (error as Error).message,
        /validateBlock\(8303490\) failed after 3 attempts:/,
      );
      return true;
    },
  );
});
