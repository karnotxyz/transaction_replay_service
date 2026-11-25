import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { hash } from "starknet";
import { publishedRoots } from "../src/operations/proxyCommittedData.js";

const executor = "0x4";
const oracle = "0x5";
const selector = hash.getSelectorFromName("publish_snapshot_root");
const publish = (root: string) => [oracle, selector, "0x3", root, "0x1", "0x2"];
const invoke = {
  type: "INVOKE", sender_address: executor, nonce: "0x4", version: "0x3",
  signature: ["0x1", "0x2"], calldata: ["0x3", "0x6", "0x7", "0x0", ...publish("0x20"), ...publish("0x30")],
};
const signature = [{ public_key: "0x1", r: "0x2", s: "0x3" }];

test("extracts configured oracle roots from executor multicalls only", () => {
  assert.deepEqual(publishedRoots(invoke, executor, oracle), ["0x20", "0x30"]);
  assert.deepEqual(publishedRoots(invoke, "0x7", oracle), []);
  assert.deepEqual(publishedRoots(invoke, executor, "0x7"), []);
  assert.throws(() => publishedRoots({ ...invoke, calldata: invoke.calldata.slice(0, -1) }, executor, oracle), /Truncated/);
});

test("fetches signed updates from the proxy and waits for C2 namespace imports before replay", async (t) => {
  const token = "test-proxy-token-at-least-32-characters";
  const update = (base_root: string | null) => ({ application_id: "0x1", dataset_id: "0x2", base_root });
  const records: Record<string, unknown> = {
    "0x10": { root: "0x10", update: update(null), entries: [], signatures: signature },
    "0x20": { root: "0x0020", update: update("0x10"), entries: [], signatures: signature },
    "0x30": { root: "0x30", update: update("0x20"), entries: [], signatures: signature },
  };
  const lookups: string[] = [];
  let proxyStatus = 404;
  const applied = new Set<string>();
  const trace: string[] = [];
  let reject = true;
  const tx = { ...invoke, transaction_hash: "0x123" };
  const gas = { price_in_wei: "0x1", price_in_fri: "0x2" };
  const block = {
    block_number: 10, block_hash: "0x10", timestamp: 123,
    status: "ACCEPTED_ON_L2", starknet_version: "0.14.2",
    sequencer_address: "0x1", l1_da_mode: "BLOB", parent_hash: "0x9", new_root: "0x1",
    l1_gas_price: gas, l1_data_gas_price: gas, l2_gas_price: gas,
  };
  const receipts = { ...block, transactions: [{ transaction: tx, receipt: {
    transaction_hash: tx.transaction_hash, execution_status: "SUCCEEDED", events: [],
  } }] };
  const proxy = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer " + token);
    const url = new URL(req.url!, "http://localhost");
    assert.equal(url.pathname, "/feeder_gateway/get_signed_committed_data_update");
    const root = url.searchParams.get("root")!;
    lookups.push(root);
    if (root === "0x10") {
      assert.equal(url.searchParams.get("application_id"), "0x1");
      assert.equal(url.searchParams.get("dataset_id"), "0x2");
      assert.equal(url.searchParams.has("transaction_hash"), false);
    } else {
      assert.equal(url.searchParams.get("transaction_hash"), "0x123");
      assert.equal(url.searchParams.has("application_id"), false);
    }
    res.statusCode = proxyStatus;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(proxyStatus === 200 ? records[root] : {}));
    if (proxyStatus === 503) proxyStatus = 200;
  }).listen(0, "127.0.0.1");
  t.after(() => proxy.close());
  await new Promise<void>(resolve => proxy.once("listening", resolve));
  const proxyUrl = "http://127.0.0.1:" + (proxy.address() as AddressInfo).port;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      // Both roots exist globally. Their namespace labels are registered only after import.
      const roots = url.pathname.endsWith("get_committed_data_roots")
        ? ["0x10", "0x20", ...applied].filter((root, index, values) => values.indexOf(root) === index)
        : [...applied];
      const cursor = url.searchParams.get("after") ?? url.searchParams.get("root") ?? "-1";
      const available = roots.filter(root => BigInt(root) > BigInt(cursor)).sort();
      res.end(JSON.stringify(url.pathname.endsWith("get_committed_data_versions")
        ? available.map(root => ({ root, application_id: "0x1", dataset_id: "0x2" })) : available));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    let result: unknown = null;
    if (request.method === "madara_V0_1_0_updateCommittedDataSet") {
      const [, root, , signatures] = request.params;
      assert.deepEqual(signatures, signature);
      trace.push(root);
      if (root === "0x20" && reject) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: 500, message: "import rejected" } }));
        return;
      }
      applied.add(root);
    } else if (request.method === "madara_V0_1_0_replayBlock") {
      assert.deepEqual([...applied], ["0x10", "0x20", "0x30"]);
      assert.equal(request.params[0].transactions[0].transaction_hash, tx.transaction_hash);
      trace.push("replay");
      result = { block_number: 10, block_hash: "0x10", transaction_hashes: [tx.transaction_hash] };
    } else if (request.method === "starknet_getBlockWithReceipts") {
      result = receipts;
    } else {
      assert.fail("Unexpected RPC " + request.method);
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }).listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  Object.assign(process.env, {
    RPC_URL_ORIGINAL_NODE: url, RPC_URL_SYNCING_NODE: url, ADMIN_RPC_URL_SYNCING_NODE: url,
    REPLAY_MODE: "managed_blocks", REPLAY_BLOCK_RPC_ENABLED: "true", MANAGED_BLOCK_MAX_INFLIGHT: "1",
    COMMITTED_DATA_REPLAY_ENABLED: "true", COMMITTED_DATA_REPLAY_SOURCE: "proxy",
    COMMITTED_DATA_PROXY_FEEDER_URL: proxyUrl + "/feeder_gateway", COMMITTED_DATA_PROXY_TOKEN: token,
    COMMITTED_DATA_EXECUTOR_ADDRESS: executor, COMMITTED_DATA_ORACLE_ADDRESS: oracle,
    COMMITTED_DATA_TARGET_RPC_URL: url, COMMITTED_DATA_TARGET_FEEDER_URL: url + "/feeder_gateway",
  });

  const source = { ...block, transactions: [tx] };
  const { replayBlock } = await import("../src/operations/replayBlockOperations.js");
  const replay = () => replayBlock(10, source as Parameters<typeof replayBlock>[1]);
  await assert.rejects(replay, /Proxy signed dataset lookup failed for root 0x20: 404/);
  assert.deepEqual(trace, []);
  proxyStatus = 503;
  await assert.rejects(replay, /C2 did not acknowledge committed dataset 0x20/);
  assert.deepEqual(trace, ["0x10", "0x20"]);
  assert.deepEqual(lookups.slice(0, 5), ["0x20", "0x20", "0x20", "0x10", "0x20"]);
  reject = false;
  await replay();
  assert.deepEqual(trace, ["0x10", "0x20", "0x20", "0x30", "replay"]);
});
