import { Account, Deployer, hash } from 'starknet';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { c1, c1Private, provider, rpc, receipt } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const contractBase = join(here, 'fixture/target/dev/local_committed_data_replay_ReplayOracle');
const output = process.env.RUN_FILE || join(here, 'run.json');
const leafDomain = '0x43445f4d50545f4c4541465f5631';
const batch = process.argv.includes('--batch');
const adminRpc = process.env.C1_ADMIN_RPC || 'http://127.0.0.1:19943/rpc/v0.1.0/';

function localDevnetAccount() {
  const logs = execFileSync('docker', ['logs', process.env.C1_CONTAINER || 'local-replay-c1'], { encoding: 'utf8' });
  const match = logs.match(/\(#1\) Address: (0x[0-9a-f]+)\s+Private key: (0x[0-9a-f]+)/i);
  if (!match) throw new Error('Cannot find the first local devnet account in C1 startup logs');
  return { address: match[1], signer: match[2] };
}

async function closeWhenPreconfirmed(hashes) {
  if (!batch) return;
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const block = await rpc(c1, 'starknet_getBlockWithTxHashes', ['pre_confirmed']);
    const found = new Set(block.transactions.map(tx => typeof tx === 'string' ? tx : tx.transaction_hash));
    if (hashes.every(hash => found.has(hash))) {
      await rpc(adminRpc, 'madara_V0_1_0_closeBlock');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Transactions did not enter one preconfirmed block: ${hashes.join(', ')}`);
}

async function main() {
  const source = provider(c1);
  const { address, signer } = localDevnetAccount();
  const account = new Account({
    provider: source, address, signer,
    deployer: new Deployer('0x041a78e741e5af2fec34b695679bc6891742439f7afb8484ecd7766661ad02bf', 'deployContract'),
  });
  const chainId = await source.getChainId();
  if (chainId !== '0x4c4f43414c5f5245504c4159') throw new Error(`Unexpected chain ID ${chainId}`);
  let run;
  if (process.argv.includes('--continue')) {
    run = JSON.parse(readFileSync(output, 'utf8'));
    if (BigInt(run.account) !== BigInt(address)) throw new Error('run.json belongs to another devnet account');
  } else {
    const startBlock = Number(await rpc(c1, 'starknet_blockNumber')) + 1;
    const sierra = JSON.parse(readFileSync(`${contractBase}.contract_class.json`, 'utf8'));
    const casm = JSON.parse(readFileSync(`${contractBase}.compiled_contract_class.json`, 'utf8'));
    const declaration = await account.declareIfNot({ contract: sierra, casm });
    if (declaration.transaction_hash) await closeWhenPreconfirmed([declaration.transaction_hash]);
    if (declaration.transaction_hash) await receipt(c1, declaration.transaction_hash);
    const deployment = await account.deploy({ classHash: declaration.class_hash, constructorCalldata: [address], unique: true });
    await closeWhenPreconfirmed([deployment.transaction_hash]);
    await receipt(c1, deployment.transaction_hash);
    run = { startBlock, account: address, contract: deployment.contract_address[0], declaration: declaration.transaction_hash, deployment: deployment.transaction_hash, rounds: [] };
    writeFileSync(output, JSON.stringify(run, null, 2));
  }

  // Let starknet.js construct/sign the account transaction, then route this one
  // already signed INVOKE through Madara's atomic import-before-admission RPC.
  const originalFetch = account.channel.fetchEndpoint.bind(account.channel);
  let pendingDataset;
  account.channel.fetchEndpoint = async (method, params) => {
    if (method === 'starknet_addInvokeTransaction' && pendingDataset) {
      const dataset = pendingDataset;
      pendingDataset = undefined;
      return rpc(c1Private, 'madara_V0_1_0_importCommittedDataAndSubmitTransaction', [[dataset], params.invoke_transaction]);
    }
    return originalFetch(method, params);
  };

  async function sendRound(price) {
    const initialNonce = batch ? BigInt(await rpc(c1, 'starknet_getNonce', ['latest', address])) : undefined;
    const details = (offset) => initialNonce === undefined ? {} : { nonce: `0x${(initialNonce + BigInt(offset)).toString(16)}` };
    const root = hash.computePoseidonHashOnElements([leafDomain, 0, price]);
    const tick = await account.execute({ contractAddress: run.contract, entrypoint: 'set_legacy_price', calldata: [price] }, details(0));
    if (!batch) await receipt(c1, tick.transaction_hash);
    pendingDataset = { root, entries: [['0x0', `0x${price.toString(16)}`]] };
    const update = await account.execute({ contractAddress: run.contract, entrypoint: 'set_root', calldata: [root] }, details(1));
    if (pendingDataset) throw new Error('Combined dataset submission was not used');
    if (!batch) await receipt(c1, update.transaction_hash);
    const settle = await account.execute({ contractAddress: run.contract, entrypoint: 'settle', calldata: [2, 3] }, details(2));
    await closeWhenPreconfirmed([tick.transaction_hash, update.transaction_hash, settle.transaction_hash]);
    const settledReceipt = await receipt(c1, settle.transaction_hash);
    if (settledReceipt.execution_status !== 'SUCCEEDED') throw new Error(`C1 settle failed: ${JSON.stringify(settledReceipt)}`);
    if (batch) {
      const tickReceipt = await receipt(c1, tick.transaction_hash);
      const updateReceipt = await receipt(c1, update.transaction_hash);
      if (tickReceipt.block_number !== settledReceipt.block_number || updateReceipt.block_number !== settledReceipt.block_number) {
        throw new Error('A price round crossed a C1 block boundary');
      }
    }
    run.rounds.push({ price, root, tick: tick.transaction_hash, update: update.transaction_hash, settle: settle.transaction_hash });
    writeFileSync(output, JSON.stringify(run, null, 2));
    console.log(`C1 price=${price} root=${root} settle=${settle.transaction_hash}`);
  }

  if (!process.argv.includes('--continue')) {
    for (const price of [42, 43]) await sendRound(price);
  }
  if (process.argv.includes('--follow')) {
    let nextPrice = run.rounds.length ? run.rounds.at(-1).price + 1 : 42;
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 10000));
      await sendRound(nextPrice++);
    }
  }
  console.log(`Producer complete: ${output}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
