import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hash } from 'starknet';
import { c1, c2, rpc } from './common.mjs';

const run = JSON.parse(readFileSync(process.env.RUN_FILE || new URL('./managed-run.json', import.meta.url), 'utf8'));
assert.equal(run.stressBlocks?.length, 20, 'expected 20 stress blocks');
const selectors = ['set_legacy_price', 'set_root', 'settle'].map(name => BigInt(hash.getSelectorFromName(name)));
let total = 0;

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
    assert.deepEqual(b.transaction, a.transaction, `block ${expected.blockNumber} transaction ${index}`);
    assert.equal(a.receipt.execution_status, 'SUCCEEDED');
    assert.equal(b.receipt.execution_status, 'SUCCEEDED');
    assert.equal(BigInt(b.receipt.transaction_hash), BigInt(a.receipt.transaction_hash));
    assert.deepEqual(b.receipt.events, a.receipt.events, `block ${expected.blockNumber} transaction ${index} events`);
  }
  assert.deepEqual(counts, [expected.rounds, expected.rounds, expected.rounds]);
  total += expected.txCount;
  console.log(`verified block ${expected.blockNumber}: ${expected.txCount} tx (${counts.join('/')})`);
}
console.log(`verified 20 blocks, ${total} transactions, ${total / 3} of each operation`);
