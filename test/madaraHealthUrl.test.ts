import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { madaraHealthUrl } from "../src/madara/healthUrl.js";

describe("madaraHealthUrl", () => {
  it("replaces the RPC version path with the root health endpoint", () => {
    assert.equal(
      madaraHealthUrl(
        "http://madara.parallel-merkle-testing.svc.cluster.local:9944/rpc/v0_10",
      ),
      "http://madara.parallel-merkle-testing.svc.cluster.local:9944/health",
    );
  });

  it("discards RPC query parameters and fragments", () => {
    assert.equal(
      madaraHealthUrl("https://madara.example/rpc/v0.10.2/?debug=1#rpc"),
      "https://madara.example/health",
    );
  });
});
