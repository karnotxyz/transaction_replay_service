import assert from "node:assert/strict";
import test from "node:test";
import { SourceBlockPrefetcher } from "../src/sync/SourceBlockPrefetcher.js";
import type { SourceBlockWithTxs } from "../src/types.js";

function makeBlock(blockNumber: number): SourceBlockWithTxs {
  return {
    block_hash: `0x${blockNumber.toString(16)}`,
    block_number: blockNumber,
    timestamp: blockNumber,
    l1_data_gas_price: {
      price_in_fri: "0x1",
      price_in_wei: "0x1",
    },
    l1_gas_price: {
      price_in_fri: "0x1",
      price_in_wei: "0x1",
    },
    l2_gas_price: {
      price_in_fri: "0x1",
      price_in_wei: "0x1",
    },
    transactions: [],
  };
}

test("SourceBlockPrefetcher prefetches the requested block and a future window", async () => {
  const fetched: number[] = [];
  const prefetcher = new SourceBlockPrefetcher(async (blockNumber) => {
    fetched.push(blockNumber);
    return makeBlock(blockNumber);
  }, 2);

  prefetcher.prime(100, 110);
  assert.deepEqual(fetched, [100, 101, 102]);

  const block100 = await prefetcher.take(100, 110);
  assert.equal(block100.block_number, 100);
  assert.deepEqual(fetched, [100, 101, 102, 103]);

  const block101 = await prefetcher.take(101, 110);
  assert.equal(block101.block_number, 101);
  assert.deepEqual(fetched, [100, 101, 102, 103, 104]);
});

test("SourceBlockPrefetcher can be disabled with a zero future window", async () => {
  const fetched: number[] = [];
  const prefetcher = new SourceBlockPrefetcher(async (blockNumber) => {
    fetched.push(blockNumber);
    return makeBlock(blockNumber);
  }, 0);

  prefetcher.prime(200, 210);
  assert.deepEqual(fetched, [200]);

  await prefetcher.take(200, 210);
  assert.deepEqual(fetched, [200]);
});
