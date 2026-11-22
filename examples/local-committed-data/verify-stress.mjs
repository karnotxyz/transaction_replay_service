import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hash } from 'starknet';
import { c1, c2, rpc } from './common.mjs';

const run = JSON.parse(readFileSync(process.env.RUN_FILE || new URL('./managed-run.json', import.meta.url), 'utf8'));
assert.equal(run.stressBlocks?.length, 20, 'expected 20 stress blocks');
assert.ok(run.legacyOffset > 0, 'expected deliberately different legacy and committed prices');
const selectors = ['set_legacy_price', 'set_root', 'settle'].map(name => BigInt(hash.getSelectorFromName(name)));
const boundary = await Promise.all([c1, c2].map(url => rpc(url, 'starknet_getBlockWithReceipts', [{ block_number: run.forkBoundaryBlock }])));
assert.equal(boundary[0].transactions.length, 0, 'C1 fork boundary must be empty');
assert.equal(boundary[1].transactions.length, 1, 'C2 fork boundary must contain the enable transaction');
assert.equal(boundary[1].transactions[0].receipt.execution_status, 'SUCCEEDED');
let total = 0;
let roundIndex = 0;

for (const expected of run.stressBlocks) {
  const id = [{ block_number: expected.blockNumber }];
  const [source, target] = await Promise.all([
    rpc(c1, 'starknet_getBlockWithReceipts', id),
    rpc(c2, 'starknet_getBlockWithReceipts', id),
  ]);
  assert.notEqual(BigInt(source.block_hash), BigInt(target.block_hash), `block ${expected.blockNumber} hash`);
  for (const key of ['block_number', 'timestamp', 'starknet_version', 'sequencer_address', 'l1_da_mode',
    'l1_gas_price', 'l1_data_gas_price', 'l2_gas_price']) {
    assert.deepEqual(target[key], source[key], `block ${expected.blockNumber} ${key}`);
  }
  assert.equal(source.transactions.length, expected.txCount);
  assert.equal(target.transactions.length, expected.txCount);
  const records = run.rounds.slice(roundIndex, roundIndex + expected.rounds);
  assert.equal(records.length, expected.rounds);
  const counts = [0, 0, 0];
  for (let index = 0; index < expected.txCount; index++) {
    const a = source.transactions[index];
    const b = target.transactions[index];
    assert.equal(a.transaction.type, 'INVOKE');
    assert.equal(BigInt(a.transaction.calldata[1]), BigInt(run.contract));
    const type = selectors.findIndex(selector => selector === BigInt(a.transaction.calldata[2]));
    assert.notEqual(type, -1, `block ${expected.blockNumber} transaction ${index} selector`);
    assert.equal(type, index % 3, `block ${expected.blockNumber} transaction ${index} operation order`);
    counts[type]++;
    const record = records[Math.floor(index / 3)];
    assert.equal(BigInt(a.receipt.transaction_hash), BigInt([record.tick, record.update, record.settle][type]));
    if (type === 0) assert.equal(BigInt(a.transaction.calldata.at(-1)), BigInt(record.legacyPrice));
    if (type === 1) assert.equal(BigInt(a.transaction.calldata.at(-1)), BigInt(record.root));
    assert.deepEqual(b.transaction, a.transaction, `block ${expected.blockNumber} transaction ${index}`);
    assert.equal(a.receipt.execution_status, 'SUCCEEDED');
    assert.equal(b.receipt.execution_status, 'SUCCEEDED');
    assert.equal(BigInt(b.receipt.transaction_hash), BigInt(a.receipt.transaction_hash));
    assert.equal(b.receipt.events.length, a.receipt.events.length);
    let oracleEvents = 0;
    for (let eventIndex = 0; eventIndex < a.receipt.events.length; eventIndex++) {
      const sourceEvent = a.receipt.events[eventIndex];
      const targetEvent = b.receipt.events[eventIndex];
      assert.equal(BigInt(targetEvent.from_address), BigInt(sourceEvent.from_address));
      assert.deepEqual(targetEvent.keys, sourceEvent.keys);
      assert.equal(targetEvent.data.length, sourceEvent.data.length);
      if (BigInt(sourceEvent.from_address) === BigInt(run.contract)) {
        assert.equal(type, 2, 'only settle should emit the fixture event');
        oracleEvents++;
        assert.deepEqual(sourceEvent.data.map(BigInt), [BigInt(record.legacyPrice), BigInt(record.legacyPrice + 5), 0n]);
        assert.deepEqual(targetEvent.data.map(BigInt), [BigInt(record.price), BigInt(record.price + 5), 1n]);
      }
    }
    assert.equal(oracleEvents, type === 2 ? 1 : 0, `block ${expected.blockNumber} transaction ${index} oracle events`);
  }
  assert.deepEqual(counts, [expected.rounds, expected.rounds, expected.rounds]);
  for (const record of records) {
    const feeder = process.env.C2_FEEDER || 'http://127.0.0.1:48080/feeder_gateway';
    const page = await fetch(`${feeder}/get_committed_data?root=${record.root}&start=0`).then(response => response.json());
    assert.equal(BigInt(page.root), BigInt(record.root));
    assert.deepEqual(page.entries.map(([key, value]) => [BigInt(key), BigInt(value)]), [[0n, BigInt(record.price)]]);
  }
  roundIndex += expected.rounds;
  total += expected.txCount;
  console.log(`verified block ${expected.blockNumber}: ${expected.txCount} tx (${counts.join('/')})`);
}
console.log(`verified 20 blocks, ${total} transactions, ${total / 3} of each operation`);
