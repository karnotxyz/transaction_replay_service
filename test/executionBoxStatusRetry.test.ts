import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

test("execution box status retries a transient transport failure", async () => {
  let requests = 0;
  const server = http.createServer((_, response) => {
    requests++;
    if (requests === 1) {
      response.destroy();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { mode: "mixed" },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  process.env.RPC_URL_ORIGINAL_NODE = "http://original.example";
  process.env.RPC_URL_SYNCING_NODE = "http://syncing.example";
  process.env.ADMIN_RPC_URL_SYNCING_NODE = `http://127.0.0.1:${address.port}`;

  try {
    const { getExecutionBoxStatus } =
      await import("../src/operations/blockOperations.js");
    const status = await getExecutionBoxStatus();

    assert.equal(status.mode, "mixed");
    assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
