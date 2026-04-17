import assert from "node:assert/strict";
import test from "node:test";
import {
  compareStarknetVersions,
  normalizeStarknetVersion,
} from "../src/starknetVersion.js";

test("normalizeStarknetVersion strips prefixes and suffixes", () => {
  assert.equal(normalizeStarknetVersion("0.14.1"), "0.14.1");
  assert.equal(normalizeStarknetVersion("v0.14.1"), "0.14.1");
  assert.equal(normalizeStarknetVersion("0.14.2-rc1"), "0.14.2");
});

test("compareStarknetVersions compares numeric segments", () => {
  assert.equal(compareStarknetVersions("0.14.2", "0.14.2"), 0);
  assert.equal(compareStarknetVersions("0.14.2", "0.14.1"), 1);
  assert.equal(compareStarknetVersions("0.14.1", "0.14.2"), -1);
  assert.equal(compareStarknetVersions("v0.14.2-rc1", "0.14.2"), 0);
  assert.equal(compareStarknetVersions("0.15.0", "0.14.9"), 1);
});

test("normalizeStarknetVersion rejects invalid values", () => {
  assert.throws(
    () => normalizeStarknetVersion("release-0.14.2"),
    /Invalid Starknet version/,
  );
});
