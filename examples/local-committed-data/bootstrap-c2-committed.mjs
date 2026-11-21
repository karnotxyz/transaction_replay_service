import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Account } from 'starknet';
import { c1, c2, provider, rpc, receipt } from './common.mjs';

const run = JSON.parse(readFileSync(process.env.RUN_FILE || new URL('./managed-run.json', import.meta.url), 'utf8'));
const adminRpc = process.env.C2_ADMIN_RPC || 'http://127.0.0.1:49943/rpc/v0.1.0/';
assert.equal(run.forkBoundaryBlock, 3, 'C1 must have an empty block 3 for C2 activation');
assert.equal(await rpc(c2, 'starknet_blockNumber'), 0, 'C2 must start from fresh genesis');
assert.equal(await rpc(c1, 'starknet_chainId'), await rpc(c2, 'starknet_chainId'));

async function closeWith(hash) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    const pending = await rpc(c2, 'starknet_getBlockWithTxHashes', ['pre_confirmed']);
    if (pending.transactions.some(tx => BigInt(typeof tx === 'string' ? tx : tx.transaction_hash) === BigInt(hash))) {
      await rpc(adminRpc, 'madara_V0_1_0_closeBlock');
      return receipt(c2, hash);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`C2 bootstrap transaction ${hash} never entered preconfirmed block`);
}

for (const blockNumber of [1, 2]) {
  const block = await rpc(c1, 'starknet_getBlockWithTxs', [{ block_number: blockNumber }]);
  assert.equal(block.transactions.length, 1);
  const { transaction_hash: sourceHash, ...transaction } = block.transactions[0];
  let result;
  if (transaction.type === 'DECLARE') {
    const contractClass = await rpc(c1, 'starknet_getClass', ['latest', transaction.class_hash]);
    const { class_hash, ...fields } = transaction;
    result = await rpc(c2, 'starknet_addDeclareTransaction', [{ ...fields, contract_class: contractClass }]);
  } else {
    assert.equal(transaction.type, 'INVOKE');
    result = await rpc(c2, 'starknet_addInvokeTransaction', [transaction]);
  }
  assert.equal(BigInt(result.transaction_hash), BigInt(sourceHash));
  const confirmed = await closeWith(sourceHash);
  assert.equal(confirmed.block_number, blockNumber);
  assert.equal(confirmed.execution_status, 'SUCCEEDED');
  console.log(`C2 bootstrap block ${blockNumber}: replayed ${transaction.type} ${sourceHash}`);
}

const logs = execFileSync('docker', ['logs', 'local-managed-c2'], { encoding: 'utf8' });
const match = logs.match(/\(#2\) Address: (0x[0-9a-f]+)\s+Private key: (0x[0-9a-f]+)/i);
if (!match) throw new Error('Cannot find C2-only devnet admin account #2');
const admin = new Account({ provider: provider(c2), address: match[1], signer: match[2] });
const enabled = await admin.execute({ contractAddress: run.contract, entrypoint: 'enable_committed', calldata: [] });
const confirmed = await closeWith(enabled.transaction_hash);
assert.equal(confirmed.block_number, run.forkBoundaryBlock);
assert.equal(confirmed.execution_status, 'SUCCEEDED');
const sourceBoundary = await rpc(c1, 'starknet_getBlockWithTxHashes', [{ block_number: run.forkBoundaryBlock }]);
assert.equal(sourceBoundary.transactions.length, 0);
const output = { boundaryBlock: run.forkBoundaryBlock, c2ToggleTransaction: enabled.transaction_hash, c2Admin: match[1] };
writeFileSync(process.env.BOOTSTRAP_FILE || new URL('./managed-bootstrap.json', import.meta.url), JSON.stringify(output, null, 2));
console.log(`C2 committed reads enabled in block ${run.forkBoundaryBlock}; C1 block is empty.`);
