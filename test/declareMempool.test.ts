import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

function rpcServer(
  handler: (request: any) => Record<string, unknown>,
) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: handler(request) }));
    });
  });

  return new Promise<{
    url: string;
    requests: any[];
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise((closeResolve, closeReject) =>
            server.close((error) =>
              error ? closeReject(error) : closeResolve(),
            ),
          ),
      });
    });
  });
}

test("DECLARE v3 mempool replay uses the public RPC with the source class unchanged", async () => {
  const contractClass = {
    abi: "[]",
    contract_class_version: "0.1.0",
    entry_points_by_type: { CONSTRUCTOR: [], EXTERNAL: [], L1_HANDLER: [] },
    sierra_program: ["0x1"],
  };
  const source = await rpcServer(() => contractClass);
  const syncing = await rpcServer(() => ({
    class_hash: "0x456",
    transaction_hash: "0x123",
  }));

  process.env.RPC_URL_ORIGINAL_NODE = source.url;
  process.env.RPC_URL_SYNCING_NODE = syncing.url;
  process.env.ADMIN_RPC_URL_SYNCING_NODE = "http://127.0.0.1:1";
  process.env.MAX_SUPPORTED_STARKNET_VERSION = "0.14.2";

  try {
    const { generalDeclare } = await import("../src/transactions/declare.js");
    const hash = await generalDeclare(
      {
        type: "DECLARE",
        version: "0x3",
        transaction_hash: "0x123",
        class_hash: "0x456",
        compiled_class_hash: "0x789",
        sender_address: "0xabc",
        signature: ["0x1", "0x2"],
        nonce: "0x3",
        resource_bounds: {},
        tip: "0x0",
        paymaster_data: [],
        account_deployment_data: [],
        nonce_data_availability_mode: "L1",
        fee_data_availability_mode: "L1",
      } as any,
      "mempool",
    );

    assert.equal(hash, "0x123");
    assert.equal(syncing.requests.length, 1);
    assert.equal(syncing.requests[0].method, "starknet_addDeclareTransaction");
    assert.deepEqual(
      syncing.requests[0].params[0].contract_class,
      contractClass,
    );
  } finally {
    await Promise.all([source.close(), syncing.close()]);
  }
});
