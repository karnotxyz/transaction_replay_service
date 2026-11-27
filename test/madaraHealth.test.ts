import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

test("Madara recovery probes the root health endpoint for a versioned RPC URL", async (t) => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.end("OK");
      return;
    }
    response.writeHead(405).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert(address && typeof address !== "string");
  process.env.RPC_URL_ORIGINAL_NODE = "http://original.example";
  process.env.RPC_URL_SYNCING_NODE = `http://127.0.0.1:${address.port}/rpc/v0_10`;
  process.env.ADMIN_RPC_URL_SYNCING_NODE = "http://admin.example";

  const { checkMadaraHealth } = await import("../src/madara/health.js");
  assert.equal(await checkMadaraHealth(), true);
});
