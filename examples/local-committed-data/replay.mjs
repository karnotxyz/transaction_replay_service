import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Account, hash } from 'starknet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { c1, c2, c1Feeder, c2Private, provider, rpc, receipt } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const run = JSON.parse(readFileSync(join(here, 'run.json'), 'utf8'));
const checkpointFile = join(here, 'checkpoint.json');
const follow = process.argv.includes('--follow');
const importedRoots = new Set();
const seen = new Set();
let nextBlock = run.startBlock;
let enabled = false;
try {
  const checkpoint = JSON.parse(readFileSync(checkpointFile, 'utf8'));
  if (checkpoint.account === run.account && checkpoint.contract === run.contract) {
    nextBlock = checkpoint.nextBlock;
    enabled = checkpoint.enabled;
  }
} catch {}

async function enableC2() {
  if (enabled) return;
  const logs = execFileSync('docker', ['logs', 'local-replay-c2'], { encoding: 'utf8' });
  const match = logs.match(/\(#2\) Address: (0x[0-9a-f]+)\s+Private key: (0x[0-9a-f]+)/i);
  if (!match) throw new Error('Cannot find C2 fixture admin in local devnet logs');
  const admin = new Account({ provider: provider(c2), address: match[1], signer: match[2] });
  const response = await admin.execute({ contractAddress: run.contract, entrypoint: 'enable_committed', calldata: [] });
  const result = await receipt(c2, response.transaction_hash);
  if (result.execution_status !== 'SUCCEEDED') throw new Error(`C2 fixture enable failed: ${response.transaction_hash}`);
  enabled = true;
  console.log(`Enabled committed read path on C2 with separate account ${match[1]}`);
}

async function feeder(path) {
  const response = await fetch(`${c1Feeder}/${path}`);
  if (!response.ok) throw new Error(`C1 feeder ${path}: HTTP ${response.status}`);
  return response.json();
}

async function copyDatasets() {
  // The feeder catalog is complete and lexically paged. Import every unseen
  // dataset before admitting the next source transaction; the on-chain root
  // publication then sees exactly the data already admitted on C1.
  let after;
  while (true) {
    const roots = await feeder(`get_committed_data_roots${after ? `?after=${after}` : ''}`);
    for (const root of roots) {
      if (importedRoots.has(root)) continue;
      let entries = [];
      let count;
      do {
        const page = await feeder(`get_committed_data?root=${root}&start=${entries.length}`);
        if (!page || page.root !== root) throw new Error(`Missing C1 dataset ${root}`);
        count = page.count;
        entries.push(...page.entries);
      } while (entries.length < count);
      await rpc(c2Private, 'madara_V0_1_0_importCommittedDataSet', [root, entries, []]);
      importedRoots.add(root);
      console.log(`Copied committed dataset ${root} (${entries.length} entries)`);
    }
    if (roots.length < 64) break;
    after = roots.at(-1);
  }
}

async function transactionOnTarget(hash) {
  try { return await rpc(c2, 'starknet_getTransactionReceipt', [hash]); }
  catch (error) {
    if (String(error).includes('Transaction hash not found')) return undefined;
    throw error;
  }
}

async function sendTransaction(tx) {
  if (await transactionOnTarget(tx.transaction_hash)) return;
  const { transaction_hash, ...broadcast } = tx;
  let result;
  switch (tx.type) {
    case 'INVOKE':
      result = await rpc(c2, 'starknet_addInvokeTransaction', [broadcast]);
      break;
    case 'DECLARE': {
      const contractClass = await rpc(c1, 'starknet_getClass', ['latest', tx.class_hash]);
      const { class_hash, ...fields } = broadcast;
      result = await rpc(c2, 'starknet_addDeclareTransaction', [{ ...fields, contract_class: contractClass }]);
      break;
    }
    case 'DEPLOY_ACCOUNT':
      result = await rpc(c2, 'starknet_addDeployAccountTransaction', [broadcast]);
      break;
    default:
      throw new Error(`Unsupported source transaction ${tx.type} ${tx.transaction_hash}`);
  }
  if (result.transaction_hash !== transaction_hash) throw new Error(`Transaction hash changed: ${transaction_hash} -> ${result.transaction_hash}`);
}

function fixtureEvent(receiptValue) {
  return (receiptValue.events || []).find(event => BigInt(event.from_address) === BigInt(run.contract));
}

function checkReceipts(hash, source, target) {
  if (source.execution_status !== target.execution_status) throw new Error(`Execution status differs for ${hash}: ${source.execution_status} vs ${target.execution_status}`);
  if (source.execution_status !== 'SUCCEEDED') throw new Error(`Source transaction failed: ${hash}`);
  const sourceEvent = fixtureEvent(source);
  const targetEvent = fixtureEvent(target);
  if (!!sourceEvent !== !!targetEvent) throw new Error(`Fixture event presence differs for ${hash}`);
  if (sourceEvent) {
    if (sourceEvent.keys.join() !== targetEvent.keys.join()) throw new Error(`Fixture event key differs for ${hash}`);
    if (sourceEvent.data.length !== 3 || targetEvent.data.length !== 3) throw new Error(`Unexpected settle event shape for ${hash}`);
    const [sourcePrice, sourceResult, sourceMode] = sourceEvent.data.map(BigInt);
    const [targetPrice, targetResult, targetMode] = targetEvent.data.map(BigInt);
    if (sourcePrice !== targetPrice || sourceResult !== targetResult || sourceMode !== 0n || targetMode !== 1n) {
      throw new Error(`Oracle replay differs for ${hash}: C1=${sourceEvent.data} C2=${targetEvent.data}`);
    }
    console.log(`Validated settle ${hash}: price=${sourcePrice}, result=${sourceResult}, C1=legacy, C2=committed`);
  }
}

async function processBlock(number) {
  const block = await rpc(c1, 'starknet_getBlockWithTxs', [{ block_number: number }]);
  if (block.status === 'PENDING') throw new Error(`Source block ${number} is pending`);
  for (const tx of block.transactions) {
    if (seen.has(tx.transaction_hash)) continue;
    await copyDatasets();
    await sendTransaction(tx);
    const source = await receipt(c1, tx.transaction_hash);
    const target = await receipt(c2, tx.transaction_hash);
    checkReceipts(tx.transaction_hash, source, target);
    if (tx.transaction_hash === run.deployment) await enableC2();
    seen.add(tx.transaction_hash);
  }
  nextBlock = number + 1;
  writeFileSync(checkpointFile, JSON.stringify({ account: run.account, contract: run.contract, nextBlock, enabled }, null, 2));
  if (block.transactions.length) console.log(`Replayed C1 block ${number}: ${block.transactions.length} transactions`);
}

async function main() {
  if ((await rpc(c1, 'starknet_chainId')) !== (await rpc(c2, 'starknet_chainId'))) throw new Error('C1 and C2 chain IDs differ; signatures cannot replay');
  while (true) {
    const latest = Number(await rpc(c1, 'starknet_blockNumber'));
    while (nextBlock <= latest) await processBlock(nextBlock);
    if (!follow) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const stateCall = [{ contract_address: run.contract, entry_point_selector: hash.getSelectorFromName('get_state'), calldata: [] }, 'latest'];
  const [sourceState, targetState] = await Promise.all([
    rpc(c1, 'starknet_call', stateCall),
    rpc(c2, 'starknet_call', stateCall),
  ]);
  if (sourceState.map(BigInt).join() !== targetState.map(BigInt).join()) {
    throw new Error(`Final fixture state differs: C1=${sourceState} C2=${targetState}`);
  }
  const last = run.rounds.at(-1);
  if (BigInt(sourceState[0]) !== BigInt(last.price) || BigInt(sourceState[1]) !== BigInt(last.root) || BigInt(sourceState[2]) !== BigInt(last.price + 5)) {
    throw new Error(`Unexpected final oracle state: ${sourceState}`);
  }
  console.log(`Replay caught up through C1 block ${nextBlock - 1}; fixture receipt events validated.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
