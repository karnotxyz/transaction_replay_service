import { RpcProvider } from 'starknet';

export const c1 = process.env.C1_RPC || 'http://127.0.0.1:19944/rpc/v0.10.2/';
export const c2 = process.env.C2_RPC || 'http://127.0.0.1:29944/rpc/v0.10.2/';
export const c1Private = process.env.C1_PRIVATE_RPC || 'http://127.0.0.1:19945/rpc/v0.1.0/';
export const c2Private = process.env.C2_PRIVATE_RPC || 'http://127.0.0.1:29945/rpc/v0.1.0/';
export const c1Feeder = process.env.C1_FEEDER || 'http://127.0.0.1:18080/feeder_gateway';

export function provider(url) { return new RpcProvider({ nodeUrl: url }); }

export async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

export async function receipt(url, hash, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const value = await rpc(url, 'starknet_getTransactionReceipt', [hash]);
      if (value.finality_status === 'ACCEPTED_ON_L2' || value.finality_status === 'ACCEPTED_ON_L1') return value;
    } catch (error) {
      if (!String(error).includes('Transaction hash not found')) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${hash} at ${url}`);
}
