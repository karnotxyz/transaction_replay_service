import assert from "node:assert/strict";
import test from "node:test";
import { classifyRpcError, formatRpcError } from "./rpcError.js";

test("classifyRpcError retries only account validation failures", () => {
  assert.equal(
    classifyRpcError({ code: 55, message: "account validation failed" }),
    "retry_account_validation"
  );
  assert.equal(classifyRpcError(undefined), null);
});

test("classifyRpcError rejects other JSON-RPC failures", () => {
  const result = classifyRpcError({ code: 42, message: "rejected" });
  assert.ok(result instanceof Error);
  assert.equal(result.message, "RPC error 42: rejected");
});

test("formatRpcError preserves string details", () => {
  assert.equal(
    formatRpcError({ code: 42, message: "rejected", data: "bad nonce" }),
    "RPC error 42: rejected (bad nonce)"
  );
});

test("formatRpcError preserves structured details", () => {
  assert.equal(
    formatRpcError({ code: 51, message: "invalid", data: { reason: "hash" } }),
    'RPC error 51: invalid ({"reason":"hash"})'
  );
});

test("formatRpcError omits absent details", () => {
  assert.equal(
    formatRpcError({ code: 24, message: "block not found" }),
    "RPC error 24: block not found"
  );
});
