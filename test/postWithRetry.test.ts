import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import axios from "axios";

process.env.RPC_URL_ORIGINAL_NODE ??= "http://original.example";
process.env.RPC_URL_SYNCING_NODE ??= "http://syncing.example";
process.env.ADMIN_RPC_URL_SYNCING_NODE ??= "http://admin.example";

const { postWithRetry } =
  await import("../src/operations/transactionOperations.js");

function rpcServer(responseBody: Record<string, unknown>) {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
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

test("postWithRetry throws on JSON-RPC error responses", async () => {
  const server = await rpcServer({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "transaction was not accepted" },
  });

  try {
    await assert.rejects(
      () => postWithRetry(server.url, { jsonrpc: "2.0", id: 1 }),
      /RPC Error: transaction was not accepted \(Code: -32000\)/,
    );
  } finally {
    await server.close();
  }
});

test("postWithRetry aborts an outstanding managed-block request", async () => {
  const server = http.createServer(() => {
    // Keep the response open until the client aborts it.
  });
  const listening = await new Promise<{ url: string; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          close: () =>
            new Promise((closeResolve, closeReject) =>
              server.close((error) =>
                error ? closeReject(error) : closeResolve(),
              ),
            ),
        });
      });
    },
  );
  const controller = new AbortController();

  try {
    const request = postWithRetry(
      listening.url,
      { jsonrpc: "2.0", id: 11 },
      controller.signal,
    );
    controller.abort();
    await assert.rejects(request, /aborted/);
  } finally {
    await listening.close();
  }
});

test("postWithRetry survives more than the normal retry budget of transient DNS failures", async () => {
  const originalPost = axios.post;
  let attempts = 0;
  axios.post = (async () => {
    attempts++;
    if (attempts <= 4) {
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN madara.internal"), {
        code: "EAI_AGAIN",
      });
    }
    return { data: { jsonrpc: "2.0", id: 1, result: "ok" } };
  }) as typeof axios.post;

  try {
    const response = await postWithRetry("http://madara.internal", {
      jsonrpc: "2.0",
      id: 1,
    });
    assert.equal(response.data.result, "ok");
    assert.equal(attempts, 5);
  } finally {
    axios.post = originalPost;
  }
});
